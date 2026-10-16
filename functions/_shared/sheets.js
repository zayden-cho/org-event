/* Google Sheets REST API 래퍼 + 로컬 캐시
   ─────────────────────────────────────────────────────────
   안정성/성능 설계
     - 429/5xx 자동 재시도 : 지수 백오프 + 지터 (구글 권장 방식).
                             서비스 계정은 "사용자 1명"이라 읽기/쓰기 각 분당 60회가
                             한도 → 순간적으로 몰려도 대기 후 재시도해 흡수한다.
     - _headerCache        : 헤더맵 캐시 (TTL 10분). 시트 구조가 중간에 바뀌어도
                             오래된 위치를 영원히 믿지 않도록 만료시킨다.
     - _sheetReady         : ensureSheet 완료 여부 캐시
     - 중복 헤더 방어      : 같은 이름의 헤더가 여러 개면 "가장 왼쪽 것"만 인정
                             (QUERY 수식 등이 오른쪽에 헤더를 또 만들어도 안전)
   ─────────────────────────────────────────────────────────*/

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ── 모듈 캐시 ── */
const HEADER_TTL_MS = 10 * 60 * 1000;
const _headerCache  = new Map();   // key: `${sheetId}::${sheetName}` → { map, t }
const _headerInflight = new Map(); // 같은 헤더를 동시에 여러 번 읽지 않도록 합류
const _sheetReady   = new Set();

/* ── 재시도 설정 (테스트에서 조정 가능) ── */
const RETRY = { maxAttempts: 6, baseMs: 600, maxDelayMs: 8000 };
export function _configureRetry(o) { Object.assign(RETRY, o); }

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class SheetsError extends Error {
    constructor(status, body) {
        super(`Sheets API ${status}: ${body}`);
        this.status = status;
        /* 호출한 쪽(API 핸들러)이 "잠시 후 다시 시도하면 되는 오류"인지 알 수 있게 표시 */
        this.retryable = RETRYABLE.has(status);
    }
}

async function req(token, url, opts = {}) {
    let lastErr;
    for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                ...opts,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...(opts.headers || {}),
                },
            });
        } catch (netErr) {            // 네트워크 단절 등 → 재시도 대상
            lastErr = netErr;
            if (attempt < RETRY.maxAttempts - 1) { await sleep(backoff(attempt)); continue; }
            throw netErr;
        }

        if (res.ok) return res.json();

        const body = await res.text();
        lastErr = new SheetsError(res.status, body);
        if (!RETRYABLE.has(res.status) || attempt === RETRY.maxAttempts - 1) throw lastErr;

        /* Retry-After 헤더가 있으면 존중, 없으면 지수 백오프 */
        const ra = parseFloat(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) ? Math.min(ra * 1000, RETRY.maxDelayMs) : backoff(attempt));
    }
    throw lastErr;
}

/** 지수 백오프 + 지터: 600ms → 1.2s → 2.4s → 4.8s (최대 8s), 여러 요청이 한꺼번에 재시도하지 않게 분산 */
function backoff(attempt) {
    const exp = Math.min(RETRY.baseMs * 2 ** attempt, RETRY.maxDelayMs);
    return exp / 2 + Math.random() * (exp / 2);
}

/* 헤더 행(1행) → { 헤더명: 인덱스 }. 중복 헤더는 가장 왼쪽 것만 인정 */
function buildHeaderMap(headerRow) {
    const map = {};
    (headerRow || []).forEach((h, i) => {
        const k = String(h).trim();
        if (k && !(k in map)) map[k] = i;
    });
    return map;
}

/* ── 기본 CRUD ─────────────────────────────────────────── */

/** 범위 값 가져오기 */
export async function getValues(token, sheetId, range) {
    const url  = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}`;
    const data = await req(token, url);
    return data.values || [];
}

/** 여러 행을 "1번의 호출"로 추가 (RAW: 날짜 시리얼 변환 방지).
 구글 쿼터는 호출 횟수 기준이라 행이 몇 개든 1회로 계산된다 */
export async function appendRows(token, sheetId, sheetName, rows) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(sheetName + '!A1')}:append`
        + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return req(token, url, { method: 'POST', body: JSON.stringify({ values: rows }) });
}

export async function appendRow(token, sheetId, sheetName, values) {
    return appendRows(token, sheetId, sheetName, [values]);
}

/* ── 모아서 쓰기 (write coalescing) ─────────────────────────
   체크인이 몰리면 쓰기 호출이 사람 수만큼 나가 분당 60회 한도에 가장 먼저 걸린다.
   같은 isolate에서 거의 동시에 들어온 행들을 잠깐(BATCH_MS) 모아 한 번의 호출로 쓴다.
   - 모든 요청은 자기 행이 실제로 시트에 써질 때까지 기다린다 (성공/실패를 정확히 전달)
   - 실패하면 그 묶음 전체가 실패 → 어떤 행도 써지지 않았으므로 재시도해도 중복이 없다 */
const BATCH = { ms: 120, max: 25 };
export function _configureAppendBatch(o) { Object.assign(BATCH, o); }
const _appendQueues = new Map();   // key → { token, sheetId, sheetName, rows[], waiters[], timer }

export function appendRowBatched(token, sheetId, sheetName, values) {
    return new Promise((resolve, reject) => {
        const key = `${sheetId}::${sheetName}`;
        let q = _appendQueues.get(key);
        if (!q) { q = { sheetId, sheetName, rows: [], waiters: [], timer: null }; _appendQueues.set(key, q); }
        q.token = token;
        q.rows.push(values);
        q.waiters.push({ resolve, reject });
        if (q.rows.length >= BATCH.max || BATCH.ms <= 0) { _flushAppends(key); }
        else if (!q.timer) { q.timer = setTimeout(() => _flushAppends(key), BATCH.ms); }
    });
}

async function _flushAppends(key) {
    const q = _appendQueues.get(key);
    if (!q) return;
    _appendQueues.delete(key);
    if (q.timer) clearTimeout(q.timer);
    try {
        await appendRows(q.token, q.sheetId, q.sheetName, q.rows);
        q.waiters.forEach(w => w.resolve());
    } catch (e) {
        q.waiters.forEach(w => w.reject(e));
    }
}

/** 여러 범위를 한 번에 가져오기 (순차 API 호출 → 1회로 통합)
 ranges: ['Sheet1!A2:A', 'Sheet2!B2:Z'] 형식
 반환: 각 범위의 values 배열 (ranges 순서와 동일) */
export async function batchGetValues(token, sheetId, ranges) {
    const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const url    = `${BASE}/${sheetId}/values:batchGet?${params}`;
    const data   = await req(token, url);
    return (data.valueRanges || []).map(vr => vr.values || []);
}

/** 단일 셀 업데이트 (RAW) */
export async function updateCell(token, sheetId, range, value) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return req(token, url, { method: 'PUT', body: JSON.stringify({ values: [[value]] }) });
}

/** 여러 행/열을 한 번에 덮어쓰기 (RAW) — 결과 시트 재계산처럼
 기존 값을 새 값으로 통째로 갈아끼울 때 사용 */
export async function setValues(token, sheetId, range, values2D) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return req(token, url, { method: 'PUT', body: JSON.stringify({ values: values2D }) });
}

/** 범위 값 삭제 (헤더는 남기고 데이터 영역만 비울 때 사용) */
export async function clearValues(token, sheetId, range) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}:clear`;
    return req(token, url, { method: 'POST', body: JSON.stringify({}) });
}

/* ── 헤더 맵 (캐시 우선, TTL 10분) ────────────────────────── */

/** 헤더 이름 → 0-based 인덱스 맵 (캐시) */
export async function getHeaderMap(token, sheetId, sheetName) {
    const key = `${sheetId}::${sheetName}`;
    const hit = _headerCache.get(key);
    if (hit && Date.now() - hit.t < HEADER_TTL_MS) return hit.map;

    /* 동시에 들어온 요청들이 같은 헤더를 각자 읽지 않고 한 번의 호출에 합류 */
    if (_headerInflight.has(key)) return _headerInflight.get(key);
    const p = (async () => {
        const rows = await getValues(token, sheetId, `${sheetName}!1:1`);
        const map  = buildHeaderMap(rows[0]);
        _headerCache.set(key, { map, t: Date.now() });
        return map;
    })().finally(() => _headerInflight.delete(key));
    _headerInflight.set(key, p);
    return p;
}

/** 헤더 캐시 전체 비우기 (어드민 "캐시 갱신" 시 사용) */
export function clearHeaderCache() {
    _headerCache.clear();
    _headerInflight.clear();
    _sheetReady.clear();
}

/* ── 유틸 ─────────────────────────────────────────────── */

/** 0-based 인덱스 → 컬럼 문자 (0→A, 25→Z, 26→AA …) */
export function colLetter(idx) {
    let col = '', n = idx + 1;
    while (n > 0) {
        const r = (n - 1) % 26;
        col = String.fromCharCode(65 + r) + col;
        n   = Math.floor((n - 1) / 26);
    }
    return col;
}

/** 헤더맵에서 가장 오른쪽 컬럼의 인덱스 (행 전체를 읽을 때 범위 끝으로 사용).
 ⚠ 예전엔 "A:Z"로 고정해서 읽었는데, 반복 입력 필드 때문에 컬럼이 26개(Z)를
 넘으면 Index/운영진확인시간이 잘려 나가는 문제가 있어서 헤더 기준으로 계산한다 */
export function lastColIdx(map) {
    const idxs = Object.values(map);
    return idxs.length ? Math.max(...idxs) : 25;
}

/** 데이터 영역(2행~) 전체 범위 문자열. 예: 출석!A2:AB */
export function dataRange(sheetName, map) {
    return `${sheetName}!A2:${colLetter(lastColIdx(map))}`;
}

/* ── 검색 ──────────────────────────────────────────────── */

/** 시트 전체를 "1번의 읽기"로 가져와 메모리에서 indexColIdx 컬럼 값이 qrId인 행을 찾는다.
 (이전: 컬럼만 읽고 → 찾은 행을 다시 읽는 2번의 호출 → 1번으로 절감)
 반환: { rowNum(시트의 실제 행 번호), values } 또는 null */
export async function findRowByIndex(token, sheetId, sheetName, indexColIdx, qrId, lastCol = 25) {
    if (indexColIdx == null) return null;
    const rows = await getValues(token, sheetId, `${sheetName}!A2:${colLetter(Math.max(lastCol, indexColIdx))}`);
    for (let i = 0; i < rows.length; i++) {
        if (String((rows[i] || [])[indexColIdx] || '').trim() === qrId) {
            return { rowNum: i + 2, values: rows[i] };
        }
    }
    return null;
}

/* ── 행 추가 (헤더 기반) ───────────────────────────────── */

/** 헤더 이름 기준으로 행 추가
 preloadedMap: 이미 가져온 헤더맵 → getHeaderMap 재호출 방지 */
export async function appendRowByHeader(token, sheetId, sheetName, valuesByHeader, preloadedMap) {
    const map    = preloadedMap || await getHeaderMap(token, sheetId, sheetName);
    /* 헤더 사이에 빈 칸이 있어도 안전하도록 "가장 오른쪽 인덱스 + 1"로 길이 계산 */
    const row    = new Array(lastColIdx(map) + 1).fill('');
    Object.entries(valuesByHeader).forEach(([k, v]) => {
        if (map[k] !== undefined) row[map[k]] = v ?? '';
    });
    await appendRowBatched(token, sheetId, sheetName, row);
}

/* ── 시트 초기화 (캐시, 최초 1회만 실행) ──────────────── */

/** 시트 없으면 생성+헤더 추가, 있으면 헤더 캐시만 적재
 같은 isolate 수명 동안 두 번 다시 실행하지 않음.
 ⚠ 행사 첫 체크인이 몰릴 때 여러 요청이 동시에 "시트 없음"을 발견해서
 시트를 중복 생성하거나 헤더를 2번 쓰는 경합이 생길 수 있어서:
 (1) 같은 isolate의 동시 호출은 한 번의 실행에 합류시키고
 (2) 헤더는 append가 아니라 A1에 덮어쓰기(멱등)로 쓰고
 (3) 다른 isolate가 먼저 시트를 만든 경우("already exists")도 정상 처리한다 */
const _ensureInflight = new Map();

export async function ensureSheet(token, sheetId, sheetName, headers) {
    const key = `${sheetId}::${sheetName}`;
    if (_sheetReady.has(key)) return;
    if (_ensureInflight.has(key)) return _ensureInflight.get(key);

    const p = (async () => {
        let rows = null;
        try {
            rows = await getValues(token, sheetId, `${sheetName}!1:1`);
        } catch (e) {
            /* 5xx/429는 "시트 없음"이 아니라 일시 오류 → 재시도까지 끝난 뒤 그대로 위로 전달 */
            if (e && e.retryable) throw e;
        }

        const writeHeader = async () => {
            await setValues(token, sheetId, `${sheetName}!A1`, [headers]);
            _headerCache.set(key, { map: buildHeaderMap(headers), t: Date.now() });
        };

        if (rows === null) {
            try {
                await req(token, `${BASE}/${sheetId}:batchUpdate`, {
                    method: 'POST',
                    body:   JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
                });
            } catch (e) {
                if (!/already exists/i.test(String(e && e.message))) throw e;   // 다른 isolate가 먼저 생성
                const again = await getValues(token, sheetId, `${sheetName}!1:1`);
                if (again[0] && again[0].some(v => String(v).trim())) {
                    _headerCache.set(key, { map: buildHeaderMap(again[0]), t: Date.now() });
                    _sheetReady.add(key);
                    return;
                }
            }
            await writeHeader();
        } else if (!rows[0] || !rows[0].some(v => String(v).trim())) {
            await writeHeader();
        } else {
            _headerCache.set(key, { map: buildHeaderMap(rows[0]), t: Date.now() });
        }
        _sheetReady.add(key);
    })().finally(() => _ensureInflight.delete(key));

    _ensureInflight.set(key, p);
    return p;
}
