/* 비즈니스 로직
   ─────────────────────────────────────────────────────────
   캐시 전략:
     [응답 시트] → Cloudflare KV (1일 TTL)
       - 행사 전 또는 어드민에서 강제 갱신
       - KV miss 시 Sheets에서 fetch 후 KV에 저장
       - 모듈 메모리에도 이중 보관 (KV 읽기 비용 제거)

     [참석확인 시트] → 모듈 메모리 Map (phoneNorm → Index)
       - isolate 첫 요청에 Sheets에서 로드 (batchGet 1회)
       - 이후 체크인할 때마다 메모리에 추가 (API 추가 없음)

   결과:
     신규 체크인: appendRow 1회만 API 호출
     중복 체크인: API 호출 0회 (순수 메모리)
   ─────────────────────────────────────────────────────────
   시트 이름
     응답/크루유니언 : 외부에서 만들어지는 시트 → 하드코딩 (settings.js SHEET_NAMES)
     출석/현장/결과  : 코드가 직접 쓰는 시트 → 전부 환경변수
                       (CHECKIN_SHEET_NAME / ONSITE_SHEET_NAME / RESULT_SHEET_NAME,
                        미설정 시 settings.js DEFAULT_SHEET_NAMES 값 사용)
   ─────────────────────────────────────────────────────────
   시트 구조 (2026-09 리팩토링)
     응답 (원본, 불변)   : 응답시간 / 참여상태 / 법인 / LDAP / 이름 / 전화번호
                           / [동적 이벤트 필드...] / Index / 단톡방
     참석확인 시트       : 참석확인시간 / 법인 / LDAP / 이름 / 전화번호
                           / [동적 이벤트 필드(복사)] / [커스텀 필드] / Index / 운영진확인시간
     현장 (신청) 시트    : 현장신청시간 / 법인 / LDAP / 이름 / 전화번호
                           / [동적 이벤트 필드(신규입력)] / 조합원여부 / [커스텀 필드] / Index / 운영진확인시간
     결과 시트           : 법인 / LDAP / 이름 / 전화번호 / Index / 인원수 / 상태
                           (응답 vs 참석확인 Index diff + 현장신청 조합원매칭분, 온디맨드 재계산.
                            인원수는 "결과 시트에 인원으로 반영"이 예로 표시된 필드의 합계값이며,
                            그런 필드를 안 쓰는 행사는 신청 1건 = 신청자 본인 1명으로 간주해 항상 1.
                            노쇼/사전취소/당일취소는 체크인 자체가 없어 인원수도 항상 빈칸)
   ─────────────────────────────────────────────────────────*/

import { getAccessToken } from './auth.js';
import {
    getHeaderMap, batchGetValues, getValues,
    appendRowByHeader, updateCell, findRowByIndex,
    ensureSheet, colLetter, clearValues, setValues,
    dataRange, lastColIdx, clearHeaderCache,
} from './sheets.js';
import {
    SHEET_NAMES, DEFAULT_SHEET_NAMES, RESPONSE_STATUS, RESULT_STATUS, NO_MATCH_LABEL,
    normalizePhone, formatPhone, nowKST,
} from './settings.js';
import {
    getFieldDefinitions, getResponseDynamicGroups, extractDynamicValues,
    assignFieldValue, assignRepeatFieldValue, fieldDefHeaders, dynamicGroupHeaders,
    buildDisplayFields, parseGroupedHeader,
} from './fields.js';

/* ── 상수 ── */
const KV_RESPONSE_KEY = 'krew_response_data';
const KV_TTL_SEC      = 86400; // 1일

/* ── 참석확인 모듈 캐시 (phoneNorm → Index) ───────────
   isolate 수명 동안 유지. 새 체크인마다 자동 업데이트.     */
const _checkinCache      = new Map();
let   _checkinCacheReady = false;

/* ── 공유 캐시 계층 (응답 데이터 / 필드 정의) ────────────────
   [메모리 1분] → [KV] → [Google Sheets] 순서로 조회.
   - 메모리 TTL(1분): isolate가 낡은 값을 영원히 들고 있던 문제 방지.
                      1분마다 KV만 다시 확인하면 되므로 Sheets 호출은 거의 안 나감.
   - inflight 합류  : 같은 isolate에서 동시에 들어온 요청이 같은 데이터를
                      각자 시트에서 읽지 않고 한 번의 로딩에 합류.
   - 오류 시 stale  : Sheets가 429/장애여도, 이전 값이 있으면 그걸로 계속 서비스. */
const MEM_TTL_MS    = 60 * 1000;
const FIELD_KV_KEY  = 'krew_field_ctx';
const FIELD_KV_TTL  = 600;                 // 필드정의는 10분 (갱신 버튼으로 즉시 반영 가능)
const _mem          = new Map();           // name → { v, t }
const _inflight     = new Map();           // name → Promise

async function _sharedCache(env, name, kvKey, kvTtlSec, loader) {
    const hit = _mem.get(name);
    if (hit && Date.now() - hit.t < MEM_TTL_MS) return hit.v;
    if (_inflight.has(name)) return _inflight.get(name);

    const p = (async () => {
        const kv = env.RESPONSE_CACHE_KV;
        try {
            if (kv) {
                const v = await kv.get(kvKey, 'json');
                if (v) { _mem.set(name, { v, t: Date.now() }); return v; }
            }
            return await _reloadShared(env, name, kvKey, kvTtlSec, loader);
        } catch (e) {
            /* 로딩 실패(429 등) → 이전에 받아둔 값이 있으면 그걸로 버팀 (10초 뒤 재시도) */
            if (hit) { _mem.set(name, { v: hit.v, t: Date.now() - MEM_TTL_MS + 10000 }); return hit.v; }
            throw e;
        }
    })().finally(() => _inflight.delete(name));
    _inflight.set(name, p);
    return p;
}

/** 캐시를 무시하고 시트에서 새로 읽어 메모리+KV에 저장 */
async function _reloadShared(env, name, kvKey, kvTtlSec, loader) {
    const v = await loader();
    _mem.set(name, { v, t: Date.now() });
    if (env.RESPONSE_CACHE_KV) {
        try { await env.RESPONSE_CACHE_KV.put(kvKey, JSON.stringify(v), { expirationTtl: kvTtlSec }); } catch { /* KV 한도 등: 치명적이지 않음 */ }
    }
    return v;
}

/* ── 크루유니언(조합원 DB) 인덱스 캐시: 메모리 전용 (개인정보라 KV에는 저장하지 않음) ── */
const KREW_TTL_MS = 10 * 60 * 1000;
let _krewCache    = null;      // { byPhone: Map, cols, t }
let _krewInflight = null;


/* ═══════════════════════════════════════════════════════════
   내부 헬퍼
   ═══════════════════════════════════════════════════════════ */

async function getToken(env) {
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL,
        env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'), env.RESPONSE_CACHE_KV);
}

function checkinSheetName(env) {
    return env.CHECKIN_SHEET_NAME || DEFAULT_SHEET_NAMES.CHECKIN;
}

function onsiteSheetName(env) {
    return env.ONSITE_SHEET_NAME || DEFAULT_SHEET_NAMES.ONSITE;
}

function resultSheetName(env) {
    return env.RESULT_SHEET_NAME || DEFAULT_SHEET_NAMES.RESULT;
}

/** 필드설정에서 "동적 필드가 아닌" 커스텀 필드만 골라, 노출범위(scope)로 필터 */
/** 응답 시트 참여상태가 사전취소/당일취소인지 판정 (참석확인/현장신청 공용) */
function isCanceledStatus(regStatus) {
    return regStatus === RESPONSE_STATUS.CANCEL || regStatus === RESPONSE_STATUS.SAME_DAY_CANCEL;
}

function customFieldsForScope(fieldDefs, dynamicNames, scope) {
    return fieldDefs.filter(f =>
        !dynamicNames.has(f.name) && (f.scope === scope || f.scope === 'both'));
}

/** 커스텀 필드 목록을 순회하며 valuesByHeader에 값 대입.
 "반복 입력" 타입은 배열([{옵션명:값}, ...])이라 전용 헬퍼로, 나머지는 공용 헬퍼로 처리 */
function applyCustomFieldValues(valuesByHeader, customFields, submittedValues) {
    customFields.forEach(f => {
        const v = (submittedValues || {})[f.name];
        if (f.type === 'repeat') assignRepeatFieldValue(valuesByHeader, f, v);
        else assignFieldValue(valuesByHeader, f.name, v);
    });
}

/** 이번 행사의 필드 컨텍스트(필드정의 + 동적필드그룹)를 한 번에 로딩
 ENABLE_CUSTOM_FIELDS=false 인 경우, 응답시트에 이미 있는 "동적 이벤트 필드"의
 폼 노출 정의(참여인원, 체험프로그램 등)는 그대로 유지하되, 응답시트에 없는
 "순수 커스텀 필드"(생년월일, 1365포털ID 등)만 걸러낸다 */
async function _loadFieldContext(tk, env) {
    /* 필드설정/필드옵션/응답 헤더는 행사 중 거의 안 바뀌므로 공유 캐시로 제공.
       (이전에는 /api/config·체크인·현장신청마다 매번 시트를 2번씩 읽었음) */
    const { rawFieldDefs, dynamicGroups } = await _sharedCache(
        env, 'field', FIELD_KV_KEY, FIELD_KV_TTL, () => _fetchFieldContext(tk, env));
    const dynamicNames = new Set(dynamicGroups.map(g => g.group));

    const customFieldsEnabled = env.ENABLE_CUSTOM_FIELDS === 'true';
    const fieldDefs = customFieldsEnabled
        ? rawFieldDefs
        : rawFieldDefs.filter(f => dynamicNames.has(f.name));

    return { fieldDefs, dynamicGroups, dynamicNames };
}

/** 필드 컨텍스트 원본 로딩 (캐시 miss / 갱신 시에만 호출) */
async function _fetchFieldContext(tk, env) {
    const [rawFieldDefs, dynamicGroups] = await Promise.all([
        getFieldDefinitions(tk, env.FIELD_SHEET_ID),
        getResponseDynamicGroups(tk, env.EVENT_SHEET_ID, SHEET_NAMES.RESPONSE),
    ]);
    return { rawFieldDefs, dynamicGroups };
}

function buildCheckinHeaders(dynamicGroups, customCheckinFields) {
    return [
        '참석확인시간', '법인', 'LDAP', '이름', '전화번호',
        ...dynamicGroupHeaders(dynamicGroups),
        ...customCheckinFields.flatMap(fieldDefHeaders),
        'Index', '운영진확인시간',
    ];
}

function buildRegisterHeaders(dynamicGroups, customRegisterFields) {
    return [
        '현장신청시간', '법인', 'LDAP', '이름', '전화번호',
        ...dynamicGroupHeaders(dynamicGroups),
        '조합원여부',
        ...customRegisterFields.flatMap(fieldDefHeaders),
        'Index', '운영진확인시간',
    ];
}

/** 응답 시트 전체를 가져와 정규화된 객체 배열로 변환 */
async function _fetchAndProcessResponse(tk, env) {
    const eId  = env.EVENT_SHEET_ID;
    const rMap = await getHeaderMap(tk, eId, SHEET_NAMES.RESPONSE);

    const rPhoneCol  = rMap['전화번호'];
    const rCorpCol   = rMap['법인'];
    const rLdapCol   = rMap['LDAP'];
    const rNameCol   = rMap['이름'];
    const rIndexCol  = rMap['Index'] ?? rMap['index'];
    const rStatusCol = rMap['참여상태'];

    if (rPhoneCol == null || rIndexCol == null) {
        throw new Error('응답 시트 헤더를 확인해 주세요.');
    }

    const dynamicGroups = await getResponseDynamicGroups(tk, eId, SHEET_NAMES.RESPONSE);
    const rows = await getValues(tk, eId, dataRange(SHEET_NAMES.RESPONSE, rMap));

    return rows
        .filter(row => row.length > 0)
        .map(row => ({
            phoneNorm:     normalizePhone(String(row[rPhoneCol] || '')),
            corp:          String(row[rCorpCol]  || '').trim(),
            ldap:          rLdapCol  != null ? String(row[rLdapCol]  || '').trim() : '',
            name:          rNameCol  != null ? String(row[rNameCol]  || '').trim() : '',
            index:         String(row[rIndexCol] || '').trim(),
            regStatus:     rStatusCol != null ? String(row[rStatusCol] || '').trim() : '',
            dynamicValues: extractDynamicValues(row, dynamicGroups),
        }))
        .filter(r => r.phoneNorm && r.corp && r.index);
}

/** 응답 캐시 읽기 (메모리 1분 → KV → Sheets) */
async function _getResponseCache(env) {
    return _sharedCache(env, 'response', KV_RESPONSE_KEY, KV_TTL_SEC, async () => {
        const tk = await getToken(env);
        return _fetchAndProcessResponse(tk, env);
    });
}

/* 같은 isolate에서 같은 번호의 체크인이 동시에 처리 중인지 추적 (더블탭/재시도 경합 방지) */
const _checkinInflight = new Map();   // phoneNorm → Promise

/** 참석확인 행을 저장하고 중복 체크 캐시에 반영.
 - 같은 번호가 이미 저장 중이면 그 결과를 기다렸다가 "중복"으로 응답 (행이 2개 생기지 않게)
 - 앞선 요청이 실패했다면 이 요청이 이어서 저장을 시도한다 */
async function _saveCheckin(tk, eId, sheetName, aMap, phoneNorm, indexVal, valuesByHeader) {
    const pending = _checkinInflight.get(phoneNorm);
    if (pending) {
        try { await pending; } catch { /* 앞선 요청 실패 → 아래에서 이어서 시도 */ }
        if (_checkinCache.has(phoneNorm)) return { duplicate: true, qrId: _checkinCache.get(phoneNorm) };
        return _saveCheckin(tk, eId, sheetName, aMap, phoneNorm, indexVal, valuesByHeader);
    }

    const work = (async () => {
        await appendRowByHeader(tk, eId, sheetName, valuesByHeader, aMap);
        _checkinCache.set(phoneNorm, indexVal);
    })();
    _checkinInflight.set(phoneNorm, work);
    try { await work; } finally { _checkinInflight.delete(phoneNorm); }
    return { duplicate: false, qrId: indexVal };
}

/** 참석확인 캐시 로드 (isolate 첫 checkIn 요청 시 1회만 실행) */
async function _loadCheckinCache(tk, env, sheetName, aMap) {
    if (_checkinCacheReady) return;

    const aPhoneCol = aMap['전화번호'];
    const aIndexCol = aMap['Index'];

    if (aPhoneCol == null || aIndexCol == null) {
        _checkinCacheReady = true;
        return;
    }

    const [phones, indexes] = await batchGetValues(tk, env.EVENT_SHEET_ID, [
        `${sheetName}!${colLetter(aPhoneCol)}2:${colLetter(aPhoneCol)}`,
        `${sheetName}!${colLetter(aIndexCol)}2:${colLetter(aIndexCol)}`,
    ]);

    phones.forEach((row, i) => {
        const p     = normalizePhone(String((row || [])[0] || ''));
        const index = String((indexes[i] || [])[0] || '');
        if (p && index) _checkinCache.set(p, index);
    });

    _checkinCacheReady = true;
}


/* ═══════════════════════════════════════════════════════════
   캐시 관리 (어드민에서 호출)
   ═══════════════════════════════════════════════════════════ */

export async function preloadResponseCache(env) {
    const tk = await getToken(env);
    clearHeaderCache();   // 시트 구조(헤더 위치)가 바뀌었을 수도 있으니 헤더 캐시도 같이 비움

    /* 필드정의 → 응답 순서로 새로 읽어 메모리+KV 갱신 (응답 파싱이 헤더를 참조하므로 순서 중요) */
    await _reloadShared(env, 'field', FIELD_KV_KEY, FIELD_KV_TTL, () => _fetchFieldContext(tk, env));
    const data = await _reloadShared(env, 'response', KV_RESPONSE_KEY, KV_TTL_SEC,
        () => _fetchAndProcessResponse(tk, env));

    return { status: 'ok', count: data.length };
}

export async function invalidateCache(env) {
    _mem.clear();
    _krewCache = null;
    clearHeaderCache();
    _checkinCacheReady = false;
    _checkinCache.clear();
    _checkinInflight.clear();

    if (env.RESPONSE_CACHE_KV) {
        await env.RESPONSE_CACHE_KV.delete(KV_RESPONSE_KEY);
        await env.RESPONSE_CACHE_KV.delete(FIELD_KV_KEY);
    }

    return { status: 'ok' };
}

export async function getCacheStatus(env) {
    let kvStatus = 'KV 미설정';
    let kvCount  = 0;

    if (env.RESPONSE_CACHE_KV) {
        const kvData = await env.RESPONSE_CACHE_KV.get(KV_RESPONSE_KEY, 'json');
        kvStatus = kvData ? '캐시됨' : '미캐시';
        kvCount  = kvData ? kvData.length : 0;
    }

    const mem = _mem.get('response');
    return {
        status:            'ok',
        responseCache:     mem ? '모듈 캐시 있음' : '없음',
        responseCount:     mem ? mem.v.length : 0,
        kvStatus,
        kvCount,
        checkinCacheReady: _checkinCacheReady,
        checkinCacheCount: _checkinCache.size,
    };
}


/* ═══════════════════════════════════════════════════════════
   /api/config 용 — 참석확인/현장신청 폼에 내려줄 필드 정의
   ═══════════════════════════════════════════════════════════ */

export async function getFieldConfig(env) {
    const tk = await getToken(env);
    const { fieldDefs, dynamicNames } = await _loadFieldContext(tk, env);

    const toClientField = (f) => ({
        name:         f.name,
        type:         f.type,
        required:     f.required,
        sideNote:     f.sideNote,
        helpNote:     f.helpNote,
        repeatSource: f.repeatSource,
        repeatMax:    f.repeatMax,
        options:      f.options.map(o => ({ name: o.name, desc: o.desc, min: o.min, type: o.type })),
    });

    /* 참석확인 폼: 동적 필드는 자동 복사되므로 UI 없음 → 순수 커스텀 필드만 */
    const checkinFields = fieldDefs
        .filter(f => !dynamicNames.has(f.name) && (f.scope === 'checkin' || f.scope === 'both'))
        .map(toClientField);

    /* 현장신청 폼: 동적 필드(신규입력 필요) + 커스텀 필드 모두 */
    const registerFields = fieldDefs
        .filter(f => f.scope === 'register' || f.scope === 'both')
        .map(toClientField);

    return { checkinFields, registerFields };
}


/* ═══════════════════════════════════════════════════════════
   참석확인 (checkIn)
   ═══════════════════════════════════════════════════════════ */
export async function checkIn(env, corp, phone, customValues) {
    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const sheetName = checkinSheetName(env);
    const eId       = env.EVENT_SHEET_ID;
    const tk        = await getToken(env);

    const { fieldDefs, dynamicGroups, dynamicNames } = await _loadFieldContext(tk, env);
    const customCheckinFields = customFieldsForScope(fieldDefs, dynamicNames, 'checkin');

    await ensureSheet(tk, eId, sheetName, buildCheckinHeaders(dynamicGroups, customCheckinFields));
    const aMap = await getHeaderMap(tk, eId, sheetName);

    const [responseData] = await Promise.all([
        _getResponseCache(env),
        _loadCheckinCache(tk, env, sheetName, aMap),
    ]);

    /* ① 중복 체크 (순수 메모리, API 없음) */
    if (_checkinCache.has(phoneNorm)) {
        return { status: 'ok', qrType: 'CHECKIN', isDuplicate: true, qrId: _checkinCache.get(phoneNorm) };
    }

    /* ② 사전신청 매칭 (순수 메모리, API 없음) */
    const matched = responseData.find(r => r.phoneNorm === phoneNorm && r.corp === corp);
    if (!matched) return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };

    /* 사전취소/당일취소자는 참석확인 자체를 막음 (참여신청 상태만 체크인 허용) */
    if (isCanceledStatus(matched.regStatus)) {
        return { status: 'ok', qrType: 'CANCELED', qrId: 'KU-CANCELED' };
    }

    /* ③ 저장할 값 구성: 동적 필드는 응답데이터에서 자동 복사, 커스텀 필드는 입력값 사용
       Index는 응답 시트에서 이미 검증된 값을 그대로 사용 (참석확인 QR 조회키 겸용) */
    const valuesByHeader = {
        '참석확인시간':   nowKST(),
        '법인':          corp,
        'LDAP':          matched.ldap,
        '이름':          matched.name,
        '전화번호':      phoneFmt,
        'Index':         matched.index,
        '운영진확인시간': '',
    };
    dynamicGroups.forEach(({ group }) => assignFieldValue(valuesByHeader, group, matched.dynamicValues[group]));
    applyCustomFieldValues(valuesByHeader, customCheckinFields, customValues);

    /* ④ 출석 저장 + ⑤ 캐시 업데이트 (같은 번호가 동시에 들어와도 1건만 저장) */
    const saved = await _saveCheckin(tk, eId, sheetName, aMap, phoneNorm, matched.index, valuesByHeader);
    return { status: 'ok', qrType: 'CHECKIN', qrId: saved.qrId, isDuplicate: saved.duplicate };
}


/** 크루유니언 DB를 "전화번호 → 행들" 인덱스로 만들어 10분간 메모리에 보관.
 (이전: 현장신청 1건마다 전화번호 컬럼 전체 읽기 + 일치 행 읽기 = 2회씩 호출) */
async function _getKrewIndex(tk, env) {
    if (_krewCache && Date.now() - _krewCache.t < KREW_TTL_MS) return _krewCache;
    if (_krewInflight) return _krewInflight;

    _krewInflight = (async () => {
        const sid  = env.KREWUNION_SHEET_ID;
        const kMap = await getHeaderMap(tk, sid, SHEET_NAMES.KREWUNION);
        const cols = {
            id:    kMap['krewunionId'] ?? kMap['Krewunionid'] ?? kMap['Index'] ?? kMap['index'] ?? 0,
            corp:  kMap['법인']                          ?? 1,
            name:  kMap['한글명'] ?? kMap['이름']        ?? 2,
            ldap:  kMap['영문명'] ?? kMap['LDAP']        ?? 3,
            phone: kMap['연락처'] ?? kMap['전화번호']    ?? 4,
        };
        const rows = await getValues(tk, sid, dataRange(SHEET_NAMES.KREWUNION, kMap));
        const byPhone = new Map();
        for (const row of rows) {
            const p = normalizePhone(String((row || [])[cols.phone] || ''));
            if (!p) continue;
            if (!byPhone.has(p)) byPhone.set(p, []);
            byPhone.get(p).push(row);
        }
        _krewCache = { byPhone, cols, t: Date.now() };
        return _krewCache;
    })().finally(() => { _krewInflight = null; });
    return _krewInflight;
}


/* ═══════════════════════════════════════════════════════════
   현장신청 (onSiteRegister)
   ═══════════════════════════════════════════════════════════ */
export async function onSiteRegister(env, corp, ldap, name, phone, fieldValues) {
    if (env.ENABLE_ONSITE_REGISTER === 'false') {
        return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };
    }

    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const cSheet    = checkinSheetName(env);
    const tk        = await getToken(env);
    const eId       = env.EVENT_SHEET_ID;

    const { fieldDefs, dynamicGroups, dynamicNames } = await _loadFieldContext(tk, env);
    const customCheckinFields  = customFieldsForScope(fieldDefs, dynamicNames, 'checkin');
    const customRegisterFields = customFieldsForScope(fieldDefs, dynamicNames, 'register');

    /* ① 응답 캐시에서 사전신청자 확인 (전화번호만 매칭, 기존 동작 유지) */
    const responseData = await _getResponseCache(env);
    const preMatch      = responseData.find(r => r.phoneNorm === phoneNorm);

    /* 사전취소/당일취소자는 현장신청 화면으로 들어와도 참석확인 처리하지 않음 */
    if (preMatch && isCanceledStatus(preMatch.regStatus)) {
        return { status: 'ok', qrType: 'CANCELED', qrId: 'KU-CANCELED' };
    }

    if (preMatch) {
        /* 사전신청자가 현장신청 화면으로 들어온 경우 → 참석확인으로 처리 */
        await ensureSheet(tk, eId, cSheet, buildCheckinHeaders(dynamicGroups, customCheckinFields));
        const aMap = await getHeaderMap(tk, eId, cSheet);

        await _loadCheckinCache(tk, env, cSheet, aMap);
        if (_checkinCache.has(phoneNorm)) {
            return { status: 'ok', qrType: 'CHECKIN', isDuplicate: true, qrId: _checkinCache.get(phoneNorm) };
        }

        const valuesByHeader = {
            '참석확인시간':   nowKST(),
            '법인':          preMatch.corp,
            'LDAP':          preMatch.ldap,
            '이름':          preMatch.name,
            '전화번호':      phoneFmt,
            'Index':         preMatch.index,
            '운영진확인시간': '',
        };
        dynamicGroups.forEach(({ group }) => assignFieldValue(valuesByHeader, group, preMatch.dynamicValues[group]));
        applyCustomFieldValues(valuesByHeader, customCheckinFields, fieldValues);

        const saved = await _saveCheckin(tk, eId, cSheet, aMap, phoneNorm, preMatch.index, valuesByHeader);
        return { status: 'ok', qrType: 'CHECKIN', qrId: saved.qrId, isDuplicate: saved.duplicate };
    }

    /* ② 현장 시트 중복 확인 */
    const oSheet = onsiteSheetName(env);
    await ensureSheet(tk, eId, oSheet, buildRegisterHeaders(dynamicGroups, customRegisterFields));
    const oMap      = await getHeaderMap(tk, eId, oSheet);
    const oPhoneCol = oMap['전화번호'];
    const oIndexCol = oMap['Index'];

    /* 전화번호/Index 두 컬럼을 batchGet 1번으로 가져와 메모리에서 대조
       (이전: 전화번호 컬럼 읽기 → 일치 시 Index 셀 또 읽기 = 최대 2번) */
    if (oPhoneCol != null && oIndexCol != null) {
        const [oPhones, oIndexes] = await batchGetValues(tk, eId, [
            `${oSheet}!${colLetter(oPhoneCol)}2:${colLetter(oPhoneCol)}`,
            `${oSheet}!${colLetter(oIndexCol)}2:${colLetter(oIndexCol)}`,
        ]);
        for (let i = 0; i < oPhones.length; i++) {
            if (normalizePhone(String((oPhones[i] || [])[0] || '')) === phoneNorm) {
                const dupIdx = String((oIndexes[i] || [])[0] || '');
                /* 비조합원으로 이미 접수된 번호가 다시 오면 NOMEM으로 (예전엔 ONSITE:일치없음으로 잘못 나갔음) */
                if (!dupIdx || dupIdx === NO_MATCH_LABEL) return { status: 'ok', qrType: 'NOMEM', qrId: 'KU-NOMEM' };
                return { status: 'ok', qrType: 'ONSITE', qrId: dupIdx };
            }
        }
    }

    /* ③ 조합원 확인 */
    let memberStatus = '비조합원';
    let krewId       = null;
    try {
        const krew = await _getKrewIndex(tk, env);
        for (const row of (krew.byPhone.get(phoneNorm) || [])) {
            const baseMatch = String(row[krew.cols.corp] || '').trim() === corp
                && String(row[krew.cols.name] || '').trim() === name;
            const ldapMatch = ldap ? String(row[krew.cols.ldap] || '').trim() === ldap : true;

            if (baseMatch && ldapMatch) {
                memberStatus = '조합원';
                krewId       = String(row[krew.cols.id] || '').trim();
                break;
            }
        }
    } catch { memberStatus = '조합원DB조회실패'; }

    /* ④ 저장할 값 구성: 동적 필드는 현장에서 신규 입력받은 값을 그대로 사용 */
    const valuesByHeader = {
        '현장신청시간':   nowKST(),
        '법인':          corp,
        'LDAP':          ldap,
        '이름':          name,
        '전화번호':      phoneFmt,
        '조합원여부':    memberStatus,
        '운영진확인시간': '',
    };
    dynamicGroups.forEach(({ group }) => assignFieldValue(valuesByHeader, group, (fieldValues || {})[group]));
    applyCustomFieldValues(valuesByHeader, customRegisterFields, fieldValues);

    if (!krewId) {
        valuesByHeader['Index'] = NO_MATCH_LABEL;
        await appendRowByHeader(tk, eId, oSheet, valuesByHeader, oMap);
        return { status: 'ok', qrType: 'NOMEM', qrId: 'KU-NOMEM' };
    }

    valuesByHeader['Index'] = krewId;
    await appendRowByHeader(tk, eId, oSheet, valuesByHeader, oMap);
    return { status: 'ok', qrType: 'ONSITE', qrId: krewId };
}


/* ═══════════════════════════════════════════════════════════
   결과 시트 (응답 vs 참석확인 diff + 현장신청 조합원매칭분)
   운영진이 필요할 때마다 호출 → 매번 전체 재계산 후 덮어씀
   ═══════════════════════════════════════════════════════════ */
export async function buildResultSheet(env) {
    const tk  = await getToken(env);
    const eId = env.EVENT_SHEET_ID;
    const cSheet = checkinSheetName(env);

    /* 인원 카운터형 필드 중 "결과 시트에 인원으로 반영"이 예로 표시된 필드 찾기
       (참석확인용/현장신청용 각각 최대 1개씩 있다고 가정) */
    const { fieldDefs } = await _loadFieldContext(tk, env);
    const checkinCountField = fieldDefs.find(f =>
        f.countsAsAttendance && (f.scope === 'checkin' || f.scope === 'both'));
    const onsiteCountField = fieldDefs.find(f =>
        f.countsAsAttendance && (f.scope === 'register' || f.scope === 'both'));

    /* ① 응답 시트 읽기 */
    const rMap = await getHeaderMap(tk, eId, SHEET_NAMES.RESPONSE);
    const rCorpCol   = rMap['법인'];
    const rLdapCol   = rMap['LDAP'];
    const rNameCol   = rMap['이름'];
    const rPhoneCol  = rMap['전화번호'];
    const rIndexCol  = rMap['Index'];
    const rStatusCol = rMap['참여상태'];
    if (rPhoneCol == null || rIndexCol == null) throw new Error('응답 시트 헤더를 확인해 주세요.');

    const responseRows = await getValues(tk, eId, dataRange(SHEET_NAMES.RESPONSE, rMap));

    /* ② 참석확인 시트: Index → 전체 행 값 매핑 (diff 판정 + 인원수 조회 둘 다에 사용) */
    const cMap = await getHeaderMap(tk, eId, cSheet).catch(() => ({}));
    const cIndexCol = cMap['Index'];
    const checkedInRows = new Map(); // index -> row values
    if (cIndexCol != null) {
        const cRows = await getValues(tk, eId, dataRange(cSheet, cMap));
        cRows.forEach(row => {
            const idx = String((row || [])[cIndexCol] || '').trim();
            if (idx) checkedInRows.set(idx, row);
        });
    }

    const resultRows = [];
    responseRows.filter(row => row.length > 0).forEach(row => {
        const indexVal = String(row[rIndexCol] ?? '').trim();
        if (!indexVal) return;
        const regStatus = String(row[rStatusCol] ?? '').trim();

        let status;
        let headcount = '';
        if (regStatus === RESPONSE_STATUS.CANCEL) status = RESULT_STATUS.PRE_CANCEL;
        else if (regStatus === RESPONSE_STATUS.SAME_DAY_CANCEL) status = RESULT_STATUS.SAME_DAY_CANCEL;
        else if (checkedInRows.has(indexVal)) {
            status = RESULT_STATUS.ATTEND;
            headcount = sumHeadcount(cMap, checkedInRows.get(indexVal), checkinCountField && checkinCountField.name);
        } else {
            status = RESULT_STATUS.NO_SHOW; // 체크인 안 함 → 인원수도 자연히 빈칸
        }

        resultRows.push([
            String(row[rCorpCol] ?? ''),
            String(row[rLdapCol] ?? ''),
            String(row[rNameCol] ?? ''),
            formatPhone(row[rPhoneCol] ?? ''),
            indexVal,
            headcount,
            status,
        ]);
    });

    /* ③ 현장신청 중 조합원 매칭된 행만 "현장참여"로 추가 (일치없음/비조합원 제외) */
    const oSheet = onsiteSheetName(env);
    const oMap = await getHeaderMap(tk, eId, oSheet).catch(() => ({}));
    const oCorpCol  = oMap['법인'];
    const oLdapCol  = oMap['LDAP'];
    const oNameCol  = oMap['이름'];
    const oPhoneCol = oMap['전화번호'];
    const oIndexCol = oMap['Index'];
    if (oPhoneCol != null && oIndexCol != null) {
        const onsiteRows = await getValues(tk, eId, dataRange(oSheet, oMap));
        onsiteRows.filter(row => row.length > 0).forEach(row => {
            const idxVal = String(row[oIndexCol] ?? '').trim();
            if (!idxVal || idxVal === NO_MATCH_LABEL) return;
            resultRows.push([
                String(row[oCorpCol] ?? ''),
                String(row[oLdapCol] ?? ''),
                String(row[oNameCol] ?? ''),
                formatPhone(row[oPhoneCol] ?? ''),
                idxVal,
                sumHeadcount(oMap, row, onsiteCountField && onsiteCountField.name),
                RESULT_STATUS.ONSITE,
            ]);
        });
    }

    /* ④ 결과 시트 재작성 (헤더는 유지, 데이터 영역만 비우고 새로 씀) */
    const rSheet  = resultSheetName(env);
    const headers = ['법인', 'LDAP', '이름', '전화번호', 'Index', '인원수', '상태'];
    await ensureSheet(tk, eId, rSheet, headers);
    await clearValues(tk, eId, `${rSheet}!A2:Z`);
    if (resultRows.length) {
        await setValues(tk, eId, `${rSheet}!A2`, resultRows);
    }

    const counts = resultRows.reduce((acc, r) => {
        acc[r[6]] = (acc[r[6]] || 0) + 1;
        return acc;
    }, {});

    return { status: 'ok', count: resultRows.length, counts };
}

/** 특정 시트 한 행에서, fieldName 그룹에 속한 컬럼들(예: "인원(성인)","인원(청소년)")의
 값을 전부 더해 총 인원수를 구함. 신청 1건은 최소 신청자 본인 1명이므로,
 인원 카운터형 필드를 아예 안 쓰는 행사거나 그 컬럼을 못 찾으면 기본값 1을 반환 */
function sumHeadcount(map, rowValues, fieldName) {
    if (!rowValues) return '';
    if (!fieldName) return 1;
    let total = 0, found = false;
    Object.entries(map).forEach(([header, colIdx]) => {
        if (parseGroupedHeader(header).group !== fieldName) return;
        found = true;
        total += parseInt(rowValues[colIdx], 10) || 0;
    });
    return found ? total : 1;
}


/* ═══════════════════════════════════════════════════════════
   어드민
   ═══════════════════════════════════════════════════════════ */
export function adminVerifyPin(env, pin) {
    const correct = env.ADMIN_PIN;
    if (!correct) return { status: 'error', message: 'ADMIN_PIN 환경변수가 설정되지 않았습니다.' };
    if (String(pin).trim() !== String(correct).trim()) return { status: 'wrong', message: 'PIN이 올바르지 않습니다.' };
    return { status: 'ok' };
}

export async function adminScanQR(env, qrString, pin) {
    const pinResult = adminVerifyPin(env, pin);
    if (pinResult.status !== 'ok') return { status: 'unauthorized', message: pinResult.message };
    if (!qrString) return { status: 'error', message: 'QR 데이터가 없습니다.' };

    const parts  = String(qrString).trim().split(':');
    const qrType = parts[0];
    const qrId   = parts.slice(1).join(':').trim();

    if (qrType === 'NOSUB')    return { status: 'found', type: 'NOSUB' };
    if (qrType === 'NOMEM')    return { status: 'found', type: 'NOMEM' };
    if (qrType === 'CANCELED') return { status: 'found', type: 'CANCELED' };
    if (!qrId) return { status: 'notfound', message: '유효하지 않은 QR 코드입니다.' };

    const tk        = await getToken(env);
    const eId       = env.EVENT_SHEET_ID;
    const sheetName = qrType === 'CHECKIN' ? checkinSheetName(env) : onsiteSheetName(env);
    const lookupKey = 'Index';
    const timeKey   = qrType === 'CHECKIN' ? '참석확인시간' : '현장신청시간';

    const map       = await getHeaderMap(tk, eId, sheetName);
    const lookupIdx = map[lookupKey];
    const adminIdx  = map['운영진확인시간'];
    if (lookupIdx == null) return { status: 'error', message: `${lookupKey} 컬럼을 찾을 수 없습니다.` };

    const found = await findRowByIndex(tk, eId, sheetName, lookupIdx, qrId, lastColIdx(map));
    if (!found) return { status: 'notfound', message: 'QR 정보를 찾을 수 없습니다.\n다시 스캔해 주세요.' };

    const { rowNum, values } = found;

    const adminVal         = adminIdx != null ? (values[adminIdx] ?? '') : '';
    const alreadyConfirmed = String(adminVal ?? '').trim() !== '';
    const confirmedAt      = alreadyConfirmed ? String(adminVal).slice(11, 16) : null;

    if (!alreadyConfirmed && adminIdx != null) {
        await updateCell(tk, eId, `${sheetName}!${colLetter(adminIdx)}${rowNum}`, nowKST());
    }

    const nameIdx  = map['이름'];
    const corpIdx  = map['법인'];
    const ldapIdx  = map['LDAP'];
    const phoneIdx = map['전화번호'];
    const timeIdx  = map[timeKey];

    const timeVal   = timeIdx != null ? String(values[timeIdx] ?? '') : '';
    const timeStamp = timeVal ? timeVal.slice(11, 16) : '-';

    /* 법인/LDAP/이름/전화번호(기본골격) + 시간/조회키/운영진확인 컬럼을 제외한
       나머지(동적 이벤트 필드 전부 + 커스텀 필드 전부 + 조합원여부)를 그대로 노출 */
    const excludeSet = new Set(['참석확인시간', '현장신청시간', '법인', 'LDAP', '이름', '전화번호', 'Index', '운영진확인시간']);
    const fields = buildDisplayFields(map, values, excludeSet);

    return {
        status: 'found', type: qrType, alreadyConfirmed, confirmedAt,
        name:  nameIdx  != null ? String(values[nameIdx]  ?? '-') : '-',
        corp:  corpIdx  != null ? String(values[corpIdx]  ?? '-') : '-',
        ldap:  ldapIdx  != null ? String(values[ldapIdx]  ?? '')  : '',
        phone: phoneIdx != null ? String(values[phoneIdx] ?? '-') : '-',
        timeStamp,
        fields,
    };
}
