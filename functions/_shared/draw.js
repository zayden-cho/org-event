/* 구슬 추첨 — 서버 로직
   ─────────────────────────────────────────────────────────
   읽는 곳
     결과 시트   : 상태가 "출석" 또는 "현장참여"인 사람만 후보 (전화번호는 읽지도, 내려주지도 않는다)
     구슬수 시트 : LDAP / 구슬수 / 메모  — 우대할 사람만 적는다. 없으면 1개, 최대 5개
     추첨기록    : 이미 당첨된 사람 표시 (다음 추첨에서 제외 옵션용)
   쓰는 곳
     추첨기록    : 추첨 1번 = 당첨자 1명당 1행, 추첨ID로 묶는다
   ─────────────────────────────────────────────────────────
   같은 사람 판정(personKey): LDAP이 있으면 LDAP(소문자), 없으면 Index.
   결과 시트에 같은 사람이 두 번 들어 있어도(예: 사전신청 + 현장참여) 구슬은 한 사람 몫으로만 센다. */

import { getAccessToken } from './auth.js';
import { getHeaderMap, getValues, ensureSheet, appendRows, dataRange } from './sheets.js';
import { DEFAULT_SHEET_NAMES, RESULT_STATUS, nowKST } from './settings.js';
import { adminVerifyPin, buildResultSheet } from './logic.js';

export const MAX_MARBLES = 5;

const ELIGIBLE_STATUS = [RESULT_STATUS.ATTEND, RESULT_STATUS.ONSITE];

const MARBLE_HEADERS = ['LDAP', '구슬수', '메모'];
const DRAW_HEADERS = [
    '추첨ID', '추첨일시', '조건', '순위', '법인', 'LDAP', '이름', 'Index',
    '당첨자 구슬수', '총 구슬수', '참가자 수', '시드', '참가 구슬 목록', '비고',
];

const DRAW_ID_RE = /^D-\d{14}-[0-9a-f]{4}$/;

/* ── 내부 헬퍼 ── */
async function getToken(env) {
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL,
        env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'), env.RESPONSE_CACHE_KV);
}
const resultSheetName = (env) => env.RESULT_SHEET_NAME || DEFAULT_SHEET_NAMES.RESULT;
const marbleSheetName = (env) => env.MARBLE_SHEET_NAME || DEFAULT_SHEET_NAMES.MARBLES;
const drawSheetName   = (env) => env.DRAW_SHEET_NAME   || DEFAULT_SHEET_NAMES.DRAW;

const cell = (row, idx) => (idx == null ? '' : String((row || [])[idx] ?? '').trim());

export function personKey(ldap, index) {
    const l = String(ldap || '').trim().toLowerCase();
    return l ? `ldap:${l}` : `idx:${String(index || '').trim()}`;
}

function describeSpec(spec) {
    const side = spec.from === 'front' ? '앞에서' : '뒤에서';
    if (spec.start === spec.end) {
        if (spec.start === 1) return spec.from === 'front' ? '1등' : '꼴등';
        return `${side} ${spec.start}번째`;
    }
    return `${side} ${spec.start}~${spec.end}번째`;
}

/** 시트 이름이 없으면 만들고, 헤더가 기대와 다르면 값이 조용히 버려지지 않도록 오류로 알린다 */
async function readyHeaders(tk, eId, sheet, headers) {
    await ensureSheet(tk, eId, sheet, headers);
    const map = await getHeaderMap(tk, eId, sheet);
    const missing = headers.filter((h) => map[h] == null);
    if (missing.length) {
        throw new Error(`'${sheet}' 시트의 헤더에 [${missing.join(', ')}] 열이 없습니다. 시트를 지우고 다시 만들거나 헤더를 추가해 주세요.`);
    }
    return map;
}

/** 결과 시트에서 후보를 읽는다 → { people: Map(key → {key,corp,ldap,name,index,status}), merged, counts } */
async function readEligible(tk, eId, env) {
    const sheet = resultSheetName(env);
    let map;
    try {
        map = await getHeaderMap(tk, eId, sheet);
    } catch (e) {
        if (e && e.retryable) throw e;
        map = {};
    }
    const need = ['LDAP', '이름', 'Index', '상태'];
    if (need.some((h) => map[h] == null)) {
        throw new Error(`'${sheet}' 시트가 없거나 비어 있습니다. 관리자 화면에서 "결과 시트 생성/갱신"을 먼저 눌러 주세요.`);
    }
    const rows = await getValues(tk, eId, dataRange(sheet, map));

    const people = new Map();
    const counts = { [RESULT_STATUS.ATTEND]: 0, [RESULT_STATUS.ONSITE]: 0 };
    let merged = 0;
    for (const row of rows) {
        const status = cell(row, map['상태']);
        if (!ELIGIBLE_STATUS.includes(status)) continue;
        const ldap  = cell(row, map['LDAP']);
        const index = cell(row, map['Index']);
        const name  = cell(row, map['이름']);
        if (!name && !ldap && !index) continue;
        const key = personKey(ldap, index);
        if (people.has(key)) { merged++; continue; }
        people.set(key, { key, corp: cell(row, map['법인']), ldap, name, index, status });
        counts[status]++;
    }
    return { people, merged, counts };
}

/** 구슬수 시트 → { byLdap: Map(소문자 LDAP → 1~5), warnings: [] } */
async function readMarbleCounts(tk, eId, env) {
    const sheet = marbleSheetName(env);
    const map = await readyHeaders(tk, eId, sheet, MARBLE_HEADERS);
    const rows = await getValues(tk, eId, dataRange(sheet, map));
    const byLdap = new Map();
    const warnings = [];
    rows.forEach((row, i) => {
        const ldap = cell(row, map['LDAP']).toLowerCase();
        const raw  = cell(row, map['구슬수']);
        if (!ldap && !raw) return;
        const rowNo = i + 2;
        if (!ldap) { warnings.push(`${sheet} ${rowNo}행: LDAP이 비어 있어 무시했어요.`); return; }
        let n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
            warnings.push(`${sheet} ${rowNo}행(${ldap}): 구슬수 "${raw}" 가 올바르지 않아 1개로 처리했어요.`);
            n = 1;
        } else if (n > MAX_MARBLES) {
            warnings.push(`${sheet} ${rowNo}행(${ldap}): 구슬수 ${n}개는 최대 ${MAX_MARBLES}개로 제한했어요.`);
            n = MAX_MARBLES;
        }
        if (byLdap.has(ldap)) warnings.push(`${sheet} ${rowNo}행(${ldap}): LDAP이 중복되어 첫 번째 값을 썼어요.`);
        else byLdap.set(ldap, n);
    });
    return { byLdap, warnings };
}

/** 추첨기록 → { wonKeys: Set(personKey), ids: Set(추첨ID) } */
async function readDrawLog(tk, eId, env) {
    const sheet = drawSheetName(env);
    const map = await readyHeaders(tk, eId, sheet, DRAW_HEADERS);
    const rows = await getValues(tk, eId, dataRange(sheet, map));
    const wonKeys = new Set();
    const ids = new Set();
    for (const row of rows) {
        const id = cell(row, map['추첨ID']);
        if (id) ids.add(id);
        const ldap = cell(row, map['LDAP']);
        const index = cell(row, map['Index']);
        if (ldap || index) wonKeys.add(personKey(ldap, index));
    }
    return { wonKeys, ids, map };
}

/* ═══════════════════════════════════════════════════════════
   API 1) 후보 조회
   ═══════════════════════════════════════════════════════════ */
export async function getDrawCandidates(env, pin, refresh) {
    const auth = adminVerifyPin(env, pin);
    if (auth.status !== 'ok') return { status: 'unauthorized', message: auth.message };

    if (refresh) await buildResultSheet(env);   // 결과 시트를 지금 시점으로 다시 계산

    const tk  = await getToken(env);
    const eId = env.EVENT_SHEET_ID;

    const { people, merged, counts } = await readEligible(tk, eId, env);
    const { byLdap, warnings } = await readMarbleCounts(tk, eId, env);
    const { wonKeys } = await readDrawLog(tk, eId, env);

    const candidates = [...people.values()].map((p) => ({
        key:     p.key,
        corp:    p.corp,
        ldap:    p.ldap,
        name:    p.name,
        status:  p.status,
        marbles: (p.ldap && byLdap.get(p.ldap.toLowerCase())) || 1,
        won:     wonKeys.has(p.key),
    }));

    return {
        status: 'ok',
        candidates,
        counts,
        merged,
        warnings,
        maxMarbles: MAX_MARBLES,
        resultSheet: resultSheetName(env),
    };
}

/* ═══════════════════════════════════════════════════════════
   API 2) 추첨 기록 저장
   rec = { drawId, seed, spec:{from,start,end}, winners:[{rank,key}],
           participants:[{key,count}], excludedWon:boolean, simVersion?:number }
   ═══════════════════════════════════════════════════════════ */
export async function saveDrawRecord(env, pin, rec) {
    const auth = adminVerifyPin(env, pin);
    if (auth.status !== 'ok') return { status: 'unauthorized', message: auth.message };

    /* ── 형식 검증 ── */
    const r = rec || {};
    if (!DRAW_ID_RE.test(String(r.drawId || ''))) return { status: 'error', message: '추첨ID 형식이 올바르지 않습니다.' };
    if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 0xFFFFFFFF) return { status: 'error', message: '시드 값이 올바르지 않습니다.' };
    const spec = r.spec || {};
    if ((spec.from !== 'front' && spec.from !== 'back') || !Number.isInteger(spec.start) || !Number.isInteger(spec.end)
        || spec.start < 1 || spec.end < spec.start) {
        return { status: 'error', message: '당첨 조건이 올바르지 않습니다.' };
    }
    const winners = Array.isArray(r.winners) ? r.winners : [];
    const parts   = Array.isArray(r.participants) ? r.participants : [];
    if (winners.length !== spec.end - spec.start + 1) return { status: 'error', message: '당첨자 수가 조건과 맞지 않습니다.' };
    if (new Set(winners.map((w) => w.key)).size !== winners.length) return { status: 'error', message: '같은 사람이 중복 당첨되었습니다.' };
    if (winners.some((w, i) => w.rank !== spec.start + i)) return { status: 'error', message: '당첨 순위가 올바르지 않습니다.' };
    if (!parts.length) return { status: 'error', message: '참가자 목록이 비어 있습니다.' };

    const tk  = await getToken(env);
    const eId = env.EVENT_SHEET_ID;

    /* ── 서버가 다시 읽은 후보와 대조 (화면이 보낸 값을 그대로 믿지 않는다) ── */
    const { people } = await readEligible(tk, eId, env);
    const partMap = new Map();
    for (const p of parts) {
        if (!people.has(p.key)) return { status: 'error', message: '참가자 중 출석 처리되지 않은 사람이 있습니다. 결과 시트를 다시 계산한 뒤 추첨해 주세요.' };
        if (!Number.isInteger(p.count) || p.count < 1 || p.count > MAX_MARBLES) return { status: 'error', message: `구슬수는 1~${MAX_MARBLES}개여야 합니다.` };
        if (partMap.has(p.key)) return { status: 'error', message: '참가자가 중복되었습니다.' };
        partMap.set(p.key, p.count);
    }
    for (const w of winners) {
        if (!partMap.has(w.key)) return { status: 'error', message: '당첨자가 참가자 목록에 없습니다.' };
    }

    /* ── 같은 추첨ID가 이미 저장됐으면 그대로 성공 처리 (재전송 중복 방지) ── */
    const { ids, map: dMap } = await readDrawLog(tk, eId, env);
    if (ids.has(r.drawId)) return { status: 'ok', drawId: r.drawId, duplicate: true };

    /* ── 행 만들기 (헤더 위치 기준) ── */
    // 맵(시뮬레이션) 버전: 재현할 때 같은 맵인지 확인하는 데 쓴다
    const simVer = Number.isInteger(r.simVersion) && r.simVersion >= 1 && r.simVersion <= 9999 ? r.simVersion : 0;
    const totalMarbles = [...partMap.values()].reduce((a, b) => a + b, 0);
    const list = [...partMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, c]) => `${k}=${c}`).join(';');
    const width = Math.max(...DRAW_HEADERS.map((h) => dMap[h])) + 1;
    const when = nowKST();

    const rows = winners.map((w, i) => {
        const p = people.get(w.key);
        const v = {
            '추첨ID': r.drawId, '추첨일시': when, '조건': describeSpec(spec), '순위': w.rank,
            '법인': p.corp, 'LDAP': p.ldap, '이름': p.name, 'Index': p.index,
            '당첨자 구슬수': partMap.get(w.key), '총 구슬수': totalMarbles, '참가자 수': partMap.size,
            '시드': r.seed,
            '참가 구슬 목록': i === 0 ? list : '',      // 긴 목록은 첫 행에만
            '비고': [r.excludedWon ? '이미 당첨된 사람 제외' : '', simVer ? `맵 v${simVer}` : ''].filter(Boolean).join(' / '),
        };
        const row = new Array(width).fill('');
        DRAW_HEADERS.forEach((h) => { row[dMap[h]] = v[h]; });
        return row;
    });

    await appendRows(tk, eId, drawSheetName(env), rows);
    return { status: 'ok', drawId: r.drawId, saved: rows.length };
}

/* ═══════════════════════════════════════════════════════════
   API 3) 추첨 재현용 조회: 추첨ID → 시드 / 조건 / 참가 구슬 목록 / 당첨자
   화면이 같은 시드와 같은 참가자로 시뮬레이션을 다시 돌려, 기록과 같은 결과가 나오는지 보여준다.
   ═══════════════════════════════════════════════════════════ */
function parseSpec(text) {
    const t = String(text || '').trim();
    if (t === '1등') return { from: 'front', start: 1, end: 1 };
    if (t === '꼴등') return { from: 'back', start: 1, end: 1 };
    let m = /^(앞에서|뒤에서) (\d+)번째$/.exec(t);
    if (m) { const n = Number(m[2]); return { from: m[1] === '앞에서' ? 'front' : 'back', start: n, end: n }; }
    m = /^(앞에서|뒤에서) (\d+)~(\d+)번째$/.exec(t);
    if (m) return { from: m[1] === '앞에서' ? 'front' : 'back', start: Number(m[2]), end: Number(m[3]) };
    return null;
}

export async function getDrawReplay(env, pin, drawId) {
    const auth = adminVerifyPin(env, pin);
    if (auth.status !== 'ok') return { status: 'unauthorized', message: auth.message };

    const id = String(drawId || '').trim();
    if (!DRAW_ID_RE.test(id)) return { status: 'error', message: '추첨ID 형식이 올바르지 않습니다. (예: D-20261127153000-ab12)' };

    const tk  = await getToken(env);
    const eId = env.EVENT_SHEET_ID;
    const sheet = drawSheetName(env);
    const map = await readyHeaders(tk, eId, sheet, DRAW_HEADERS);
    const rows = (await getValues(tk, eId, dataRange(sheet, map))).filter((row) => cell(row, map['추첨ID']) === id);
    if (!rows.length) return { status: 'error', message: `추첨기록 시트에서 ${id} 를 찾을 수 없습니다.` };

    const first = rows[0];
    const spec = parseSpec(cell(first, map['조건']));
    const seed = Number(cell(first, map['시드']));
    const listText = rows.map((r) => cell(r, map['참가 구슬 목록'])).find(Boolean) || '';
    if (!spec || !Number.isInteger(seed) || !listText) {
        return { status: 'error', message: '이 추첨은 재현에 필요한 정보(조건/시드/참가 구슬 목록)가 기록에 없습니다.' };
    }

    const participants = [];
    for (const part of listText.split(';')) {
        const eq = part.lastIndexOf('=');
        if (eq < 1) continue;
        const key = part.slice(0, eq);
        const count = Number(part.slice(eq + 1));
        if (!Number.isInteger(count) || count < 1 || count > MAX_MARBLES) continue;
        participants.push({ key, count });
    }
    if (!participants.length) return { status: 'error', message: '참가 구슬 목록을 읽을 수 없습니다.' };

    /* 표시용 이름: 당첨자는 기록에서, 나머지는 현재 출석 명단에서(없으면 키에서) */
    let people = new Map();
    try { people = (await readEligible(tk, eId, env)).people; } catch (e) { if (e && e.retryable) throw e; }
    const info = new Map();
    for (const r of rows) {
        const ldap = cell(r, map['LDAP']), index = cell(r, map['Index']);
        info.set(personKey(ldap, index), { ldap, name: cell(r, map['이름']), corp: cell(r, map['법인']) });
    }
    const people2 = participants.map((p) => {
        const known = info.get(p.key) || people.get(p.key);
        const fallbackLdap = p.key.startsWith('ldap:') ? p.key.slice(5) : '';
        return {
            key: p.key, count: p.count,
            ldap: known ? known.ldap : fallbackLdap,
            name: known ? known.name : '',
            corp: known ? known.corp : '',
        };
    });

    const memo = cell(first, map['비고']);
    const ver = /맵 v(\d+)/.exec(memo);
    return {
        status: 'ok',
        drawId: id,
        when: cell(first, map['추첨일시']),
        specText: cell(first, map['조건']),
        spec, seed,
        simVersion: ver ? Number(ver[1]) : null,
        participants: people2,
        winners: rows.map((r) => ({
            rank: Number(cell(r, map['순위'])),
            key: personKey(cell(r, map['LDAP']), cell(r, map['Index'])),
        })).sort((a, b) => a.rank - b.rank),
    };
}
