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
     결과 시트           : 법인 / LDAP / 이름 / 전화번호 / Index / 상태
                           (응답 vs 참석확인 Index diff + 현장신청 조합원매칭분, 온디맨드 재계산)
   ─────────────────────────────────────────────────────────*/

import { getAccessToken } from './auth.js';
import {
    getHeaderMap, batchGetValues, getValues,
    appendRowByHeader, updateCell, findRowByIndex,
    ensureSheet, colLetter, clearValues, setValues,
} from './sheets.js';
import {
    SHEET_NAMES, DEFAULT_SHEET_NAMES, RESPONSE_STATUS, RESULT_STATUS, NO_MATCH_LABEL,
    normalizePhone, formatPhone, nowKST,
} from './settings.js';
import {
    getFieldDefinitions, getResponseDynamicGroups, extractDynamicValues,
    assignFieldValue, fieldDefHeaders, dynamicGroupHeaders, buildDisplayFields,
} from './fields.js';

/* ── 상수 ── */
const KV_RESPONSE_KEY = 'krew_response_data';
const KV_TTL_SEC      = 86400; // 1일

/* ── 참석확인 모듈 캐시 (phoneNorm → Index) ───────────
   isolate 수명 동안 유지. 새 체크인마다 자동 업데이트.     */
const _checkinCache      = new Map();
let   _checkinCacheReady = false;

/* ── 응답 모듈 캐시 (KV 읽기 비용 제거용 이중 레이어) ──── */
let _responseModuleCache = null;


/* ═══════════════════════════════════════════════════════════
   내부 헬퍼
   ═══════════════════════════════════════════════════════════ */

async function getToken(env) {
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL,
        env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'));
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
function customFieldsForScope(fieldDefs, dynamicNames, scope) {
    return fieldDefs.filter(f =>
        !dynamicNames.has(f.name) && (f.scope === scope || f.scope === 'both'));
}

/** 이번 행사의 필드 컨텍스트(필드정의 + 동적필드그룹)를 한 번에 로딩
 ENABLE_CUSTOM_FIELDS=false 인 경우, 응답시트에 이미 있는 "동적 이벤트 필드"의
 폼 노출 정의(참여인원, 체험프로그램 등)는 그대로 유지하되, 응답시트에 없는
 "순수 커스텀 필드"(생년월일, 1365포털ID 등)만 걸러낸다 */
async function _loadFieldContext(tk, env) {
    const eId = env.EVENT_SHEET_ID;
    const [rawFieldDefs, dynamicGroups] = await Promise.all([
        getFieldDefinitions(tk, env.FIELD_SHEET_ID),
        getResponseDynamicGroups(tk, eId, SHEET_NAMES.RESPONSE),
    ]);
    const dynamicNames = new Set(dynamicGroups.map(g => g.group));

    const customFieldsEnabled = env.ENABLE_CUSTOM_FIELDS === 'true';
    const fieldDefs = customFieldsEnabled
        ? rawFieldDefs
        : rawFieldDefs.filter(f => dynamicNames.has(f.name));

    return { fieldDefs, dynamicGroups, dynamicNames };
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
    const rows = await getValues(tk, eId, `${SHEET_NAMES.RESPONSE}!A2:Z`);

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

/** 응답 캐시 읽기 (모듈 → KV → Sheets 순서로 fallback) */
async function _getResponseCache(env) {
    if (_responseModuleCache) return _responseModuleCache;

    if (env.RESPONSE_CACHE_KV) {
        const kvData = await env.RESPONSE_CACHE_KV.get(KV_RESPONSE_KEY, 'json');
        if (kvData) {
            _responseModuleCache = kvData;
            return kvData;
        }
    }

    const tk   = await getToken(env);
    const data = await _fetchAndProcessResponse(tk, env);
    _responseModuleCache = data;

    if (env.RESPONSE_CACHE_KV) {
        await env.RESPONSE_CACHE_KV.put(KV_RESPONSE_KEY, JSON.stringify(data),
            { expirationTtl: KV_TTL_SEC });
    }

    return data;
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
    const tk   = await getToken(env);
    const data = await _fetchAndProcessResponse(tk, env);

    _responseModuleCache = data;

    if (env.RESPONSE_CACHE_KV) {
        await env.RESPONSE_CACHE_KV.put(KV_RESPONSE_KEY, JSON.stringify(data),
            { expirationTtl: KV_TTL_SEC });
    }

    return { status: 'ok', count: data.length };
}

export async function invalidateCache(env) {
    _responseModuleCache = null;
    _checkinCacheReady    = false;
    _checkinCache.clear();

    if (env.RESPONSE_CACHE_KV) {
        await env.RESPONSE_CACHE_KV.delete(KV_RESPONSE_KEY);
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

    return {
        status:            'ok',
        responseCache:     _responseModuleCache ? '모듈 캐시 있음' : '없음',
        responseCount:     _responseModuleCache ? _responseModuleCache.length : 0,
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
        name:     f.name,
        type:     f.type,
        required: f.required,
        sideNote: f.sideNote,
        helpNote: f.helpNote,
        options:  f.options.map(o => ({ name: o.name, desc: o.desc, min: o.min })),
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
    customCheckinFields.forEach(f => assignFieldValue(valuesByHeader, f.name, (customValues || {})[f.name]));

    /* ④ 출석 저장 (1회 API 호출, 불가피) */
    await appendRowByHeader(tk, eId, sheetName, valuesByHeader, aMap);

    /* ⑤ 참석확인 캐시 업데이트 (메모리만, 이후 중복 체크 즉시 처리) */
    _checkinCache.set(phoneNorm, matched.index);

    return { status: 'ok', qrType: 'CHECKIN', qrId: matched.index, isDuplicate: false };
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
        customCheckinFields.forEach(f => assignFieldValue(valuesByHeader, f.name, (fieldValues || {})[f.name]));

        await appendRowByHeader(tk, eId, cSheet, valuesByHeader, aMap);
        _checkinCache.set(phoneNorm, preMatch.index);
        return { status: 'ok', qrType: 'CHECKIN', qrId: preMatch.index, isDuplicate: false };
    }

    /* ② 현장 시트 중복 확인 */
    const oSheet = onsiteSheetName(env);
    await ensureSheet(tk, eId, oSheet, buildRegisterHeaders(dynamicGroups, customRegisterFields));
    const oMap      = await getHeaderMap(tk, eId, oSheet);
    const oPhoneCol = oMap['전화번호'];
    const oIndexCol = oMap['Index'];

    const oPhones = oPhoneCol != null
        ? await getValues(tk, eId, `${oSheet}!${colLetter(oPhoneCol)}2:${colLetter(oPhoneCol)}`)
        : [];

    for (let i = 0; i < oPhones.length; i++) {
        if (normalizePhone(String((oPhones[i] || [])[0] || '')) === phoneNorm) {
            const idxRow = await getValues(tk, eId,
                `${oSheet}!${colLetter(oIndexCol)}${i + 2}:${colLetter(oIndexCol)}${i + 2}`);
            return { status: 'ok', qrType: 'ONSITE', qrId: String((idxRow[0] || [])[0] || '') };
        }
    }

    /* ③ 조합원 확인 */
    let memberStatus = '비조합원';
    let krewId       = null;
    try {
        const kMap      = await getHeaderMap(tk, env.KREWUNION_SHEET_ID, SHEET_NAMES.KREWUNION);
        const kIdCol    = kMap['krewunionId'] ?? kMap['Krewunionid'] ?? kMap['Index'] ?? kMap['index'] ?? 0;
        const kCorpCol  = kMap['법인']              ?? 1;
        const kNameCol  = kMap['한글명'] ?? kMap['이름']     ?? 2;
        const kLdapCol  = kMap['영문명'] ?? kMap['LDAP']     ?? 3;
        const kPhoneCol = kMap['연락처'] ?? kMap['전화번호'] ?? 4;

        const kPhones = await getValues(tk, env.KREWUNION_SHEET_ID,
            `${SHEET_NAMES.KREWUNION}!${colLetter(kPhoneCol)}2:${colLetter(kPhoneCol)}`);

        for (let i = 0; i < kPhones.length; i++) {
            if (normalizePhone(String((kPhones[i] || [])[0] || '')) === phoneNorm) {
                const rowNum = i + 2;
                const row    = (await getValues(tk, env.KREWUNION_SHEET_ID,
                    `${SHEET_NAMES.KREWUNION}!A${rowNum}:Z${rowNum}`))[0] || [];

                const baseMatch = String(row[kCorpCol] || '').trim() === corp
                    && String(row[kNameCol] || '').trim() === name;
                const ldapMatch = ldap ? String(row[kLdapCol] || '').trim() === ldap : true;

                if (baseMatch && ldapMatch) {
                    memberStatus = '조합원';
                    krewId       = String(row[kIdCol] || '').trim();
                    break;
                }
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
    customRegisterFields.forEach(f => assignFieldValue(valuesByHeader, f.name, (fieldValues || {})[f.name]));

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

    /* ① 응답 시트 읽기 */
    const rMap = await getHeaderMap(tk, eId, SHEET_NAMES.RESPONSE);
    const rCorpCol   = rMap['법인'];
    const rLdapCol   = rMap['LDAP'];
    const rNameCol   = rMap['이름'];
    const rPhoneCol  = rMap['전화번호'];
    const rIndexCol  = rMap['Index'];
    const rStatusCol = rMap['참여상태'];
    if (rPhoneCol == null || rIndexCol == null) throw new Error('응답 시트 헤더를 확인해 주세요.');

    const responseRows = await getValues(tk, eId, `${SHEET_NAMES.RESPONSE}!A2:Z`);

    /* ② 참석확인 시트에서 체크인된 Index 집합 확보 (Index 기준 diff) */
    const cMap = await getHeaderMap(tk, eId, cSheet).catch(() => ({}));
    const cIndexCol = cMap['Index'];
    const checkedInIndexes = new Set();
    if (cIndexCol != null) {
        const indexes = await getValues(tk, eId, `${cSheet}!${colLetter(cIndexCol)}2:${colLetter(cIndexCol)}`);
        indexes.forEach(row => {
            const idx = String((row || [])[0] || '').trim();
            if (idx) checkedInIndexes.add(idx);
        });
    }

    const resultRows = [];
    responseRows.filter(row => row.length > 0).forEach(row => {
        const indexVal = String(row[rIndexCol] ?? '').trim();
        if (!indexVal) return;
        const regStatus = String(row[rStatusCol] ?? '').trim();

        let status;
        if (regStatus === RESPONSE_STATUS.CANCEL) status = RESULT_STATUS.PRE_CANCEL;
        else if (regStatus === RESPONSE_STATUS.SAME_DAY_CANCEL) status = RESULT_STATUS.SAME_DAY_CANCEL;
        else status = checkedInIndexes.has(indexVal) ? RESULT_STATUS.ATTEND : RESULT_STATUS.NO_SHOW;

        resultRows.push([
            String(row[rCorpCol] ?? ''),
            String(row[rLdapCol] ?? ''),
            String(row[rNameCol] ?? ''),
            formatPhone(row[rPhoneCol] ?? ''),
            indexVal,
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
        const onsiteRows = await getValues(tk, eId, `${oSheet}!A2:Z`);
        onsiteRows.filter(row => row.length > 0).forEach(row => {
            const idxVal = String(row[oIndexCol] ?? '').trim();
            if (!idxVal || idxVal === NO_MATCH_LABEL) return;
            resultRows.push([
                String(row[oCorpCol] ?? ''),
                String(row[oLdapCol] ?? ''),
                String(row[oNameCol] ?? ''),
                formatPhone(row[oPhoneCol] ?? ''),
                idxVal,
                RESULT_STATUS.ONSITE,
            ]);
        });
    }

    /* ④ 결과 시트 재작성 (헤더는 유지, 데이터 영역만 비우고 새로 씀) */
    const rSheet  = resultSheetName(env);
    const headers = ['법인', 'LDAP', '이름', '전화번호', 'Index', '상태'];
    await ensureSheet(tk, eId, rSheet, headers);
    await clearValues(tk, eId, `${rSheet}!A2:Z`);
    if (resultRows.length) {
        await setValues(tk, eId, `${rSheet}!A2`, resultRows);
    }

    const counts = resultRows.reduce((acc, r) => {
        acc[r[5]] = (acc[r[5]] || 0) + 1;
        return acc;
    }, {});

    return { status: 'ok', count: resultRows.length, counts };
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

    if (qrType === 'NOSUB') return { status: 'found', type: 'NOSUB' };
    if (qrType === 'NOMEM') return { status: 'found', type: 'NOMEM' };
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

    const found = await findRowByIndex(tk, eId, sheetName, lookupIdx, qrId);
    if (!found) return { status: 'notfound', message: 'QR 정보를 찾을 수 없습니다.\n다시 스캔해 주세요.' };

    const { rowNum, values } = found;

    const adminVal         = adminIdx != null ? (values[adminIdx] ?? '') : '';
    const alreadyConfirmed = adminVal && String(adminVal).trim() !== '';
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
