/* 필드 시스템 — "필드설정" / "필드옵션" 스프레드시트 탭을 읽어
   참석확인/현장신청 폼과 시트 헤더를 완전히 동적으로 구성한다.

   ※ 이 두 탭은 EVENT_SHEET_ID(행사마다 새로 만드는 응답/출석/현장 시트)가
     아니라, 별도의 고정 스프레드시트(FIELD_SHEET_ID)에 둔다.
     행사가 바뀌어도 계속 재사용하는 "필드 라이브러리" 개념이기 때문.
   ─────────────────────────────────────────────────────────────
   개념 정리
     · 동적 이벤트 필드 : 응답 시트(사전신청)에 이미 있는 컬럼
                          (전화번호 다음 ~ Index 이전 사이 전체).
                          참석확인 때는 매칭된 응답 데이터에서
                          "그대로 복사"되고(화면에 입력 UI 없음),
                          현장신청 때는 사전 데이터가 없으므로
                          그 자리에서 새로 입력받아야 한다.
     · 커스텀 필드     : 응답 시트엔 없는, 참석확인/현장신청
                          시점에 신규로 입력받는 필드
                          (생년월일, 1365포털ID 등).
     · 두 종류 모두 "필드설정" 시트에 필드명으로 등록되어 있어야
       폼에 입력 UI가 생긴다 (동적 필드는 보통 "현장신청 때만").
       등록이 안 된 동적 필드는 참석확인 시 복사는 되지만,
       현장신청 폼에는 노출되지 않는다.
   ─────────────────────────────────────────────────────────────
   필드설정 시트 컬럼:
     필드명 / 입력방식 / 어디서 받나요 / 필수 여부
     / 제목 옆 설명 / 하단 안내 박스 / 표시 순서
   필드옵션 시트 컬럼 (입력방식이 "인원 카운터" / "선택 카드"인 경우만):
     필드명 / 옵션명 / 옵션 설명 / 최소값 / 표시 순서
   ─────────────────────────────────────────────────────────────*/

import { getValues, getHeaderMap } from './sheets.js';

export const FIELD_SHEET_NAME  = '필드설정';
export const OPTION_SHEET_NAME = '필드옵션';

/* ── 한글 라벨 ↔ 내부 코드 매핑 ─────────────────────────────
   운영진은 스프레드시트에서 드롭다운으로 한글 값만 고르면 되고,
   아래 코드값은 시스템 내부에서만 쓰인다. */
const INPUT_TYPE_MAP = {
    '한 줄 텍스트':  'text',
    '전화번호 형식': 'phone',
    '생년월일 형식': 'date',
    '숫자':          'number',
    '인원 카운터':   'counter-group',
    '선택 카드':     'select',
};

const SCOPE_MAP = {
    '참석확인 때만': 'checkin',
    '현장신청 때만': 'register',
    '둘 다':         'both',
};

const REQUIRED_MAP = {
    '필수': true,
    '선택': false,
};

function scopeIncludes(scope, target) {
    return scope === 'both' || scope === target;
}

/* ── 헤더 그룹핑 컨벤션: "그룹명(하위항목명)" ──────────────── */

/** "그룹명(하위항목명)" 헤더 파싱. 괄호 없으면 sub:null */
export function parseGroupedHeader(header) {
    const m = String(header).trim().match(/^(.+?)\((.+)\)$/);
    if (!m) return { group: String(header).trim(), sub: null };
    return { group: m[1].trim(), sub: m[2].trim() };
}

/* ── 필드설정 / 필드옵션 로딩 ───────────────────────────────── */

/** 필드설정 + 필드옵션 시트를 읽어 필드 정의 배열 반환
 (1행: 빈 여백, 2행: 헤더 라벨, 3행부터 실제 데이터.
 필드명이 비어있는 행은 건너뜀) */
export async function getFieldDefinitions(token, sheetId) {
    let settingRows = [];
    let optionRows  = [];
    try {
        [settingRows, optionRows] = await Promise.all([
            getValues(token, sheetId, `${FIELD_SHEET_NAME}!A3:G`),
            getValues(token, sheetId, `${OPTION_SHEET_NAME}!A3:E`),
        ]);
    } catch {
        /* 필드설정/필드옵션 탭이 아직 없는 행사 → 커스텀 필드 없이 진행 */
        return [];
    }

    const options = {}; // 필드명 -> [{name, desc, min, order}]
    (optionRows || []).forEach(row => {
        const fieldName = String(row[0] || '').trim();
        const optName   = String(row[1] || '').trim();
        if (!fieldName || !optName) return;
        if (!options[fieldName]) options[fieldName] = [];
        options[fieldName].push({
            name:  optName,
            desc:  String(row[2] || '').trim(),
            min:   row[3] !== undefined && row[3] !== '' ? Number(row[3]) || 0 : 0,
            order: row[4] !== undefined && row[4] !== '' ? Number(row[4]) || 0 : options[fieldName].length,
        });
    });
    Object.values(options).forEach(list => list.sort((a, b) => a.order - b.order));

    return (settingRows || [])
        .filter(row => String(row[0] || '').trim())
        .map(row => {
            const name = String(row[0] || '').trim();
            return {
                name,
                type:     INPUT_TYPE_MAP[String(row[1] || '').trim()] || 'text',
                scope:    SCOPE_MAP[String(row[2] || '').trim()]      || 'both',
                required: REQUIRED_MAP[String(row[3] || '').trim()]  ?? false,
                sideNote: String(row[4] || '').trim(),
                helpNote: String(row[5] || '').trim(),
                order:    row[6] !== undefined && row[6] !== '' ? Number(row[6]) || 0 : 0,
                options:  options[name] || [],
            };
        })
        .sort((a, b) => a.order - b.order);
}

/* ── 응답 시트의 "동적 이벤트 필드" 그룹 추출 ─────────────────
   전화번호 다음 컬럼부터 Index 이전까지 전체를 대상으로 함 */
export async function getResponseDynamicGroups(token, sheetId, sheetName) {
    const map = await getHeaderMap(token, sheetId, sheetName);
    const phoneIdx = map['전화번호'];
    const indexIdx = map['Index'] ?? map['index'];
    if (phoneIdx == null || indexIdx == null) return [];

    const byIdx = {};
    Object.entries(map).forEach(([h, i]) => { byIdx[i] = h; });

    const groups = []; // [{ group, subs: [{ sub, colIdx, header }] }]
    const groupPos = {};
    for (let i = phoneIdx + 1; i < indexIdx; i++) {
        const header = byIdx[i];
        if (!header) continue;
        const { group, sub } = parseGroupedHeader(header);
        if (groupPos[group] === undefined) {
            groupPos[group] = groups.length;
            groups.push({ group, subs: [] });
        }
        groups[groupPos[group]].subs.push({ sub, colIdx: i, header });
    }
    return groups;
}

/** 응답 시트 한 행(rowValues)에서 dynamicGroups 기준으로 값 추출
 → { 그룹명: value } 또는 { 그룹명: { 하위명: value, ... } } */
export function extractDynamicValues(rowValues, dynamicGroups) {
    const result = {};
    dynamicGroups.forEach(({ group, subs }) => {
        if (subs.length === 1 && subs[0].sub === null) {
            result[group] = String(rowValues[subs[0].colIdx] ?? '').trim();
        } else {
            const obj = {};
            subs.forEach(({ sub, colIdx }) => { obj[sub] = String(rowValues[colIdx] ?? '').trim(); });
            result[group] = obj;
        }
    });
    return result;
}

/* ── 값 대입 / 헤더 생성 공용 헬퍼 ────────────────────────────
   그룹형(객체) 값이든 단일 값이든 동일한 방식으로 처리하므로,
   동적 필드(자동 복사)와 커스텀 필드(신규 입력) 양쪽에 그대로 재사용 가능 */

/** valuesByHeader 객체에 필드값 대입. 값이 객체면 "이름(하위)"로 펼침 */
export function assignFieldValue(valuesByHeader, name, value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([sub, v]) => { valuesByHeader[`${name}(${sub})`] = v ?? ''; });
    } else {
        valuesByHeader[name] = value ?? '';
    }
}

/** 커스텀 필드 정의 하나가 실제로 차지하는 시트 헤더 목록
 (인원 카운터처럼 옵션이 있으면 옵션별로 펼쳐짐) */
export function fieldDefHeaders(fieldDef) {
    if (fieldDef.type === 'counter-group' && fieldDef.options.length) {
        return fieldDef.options.map(o => `${fieldDef.name}(${o.name})`);
    }
    return [fieldDef.name];
}

/** 동적 이벤트 필드 그룹들이 시트에서 차지하는 헤더 목록
 (응답 시트의 원본 헤더 문자열을 그대로 재사용) */
export function dynamicGroupHeaders(dynamicGroups) {
    return dynamicGroups.flatMap(g => g.subs.map(s => s.header));
}

/* ── 어드민 확인뷰용: 구조 컬럼을 제외한 나머지를 그룹핑해서 표시 ── */

/** map(헤더->colIdx), rowValues, 제외할 헤더 Set을 받아
 [{label, value}] 배열로 병합 (그룹 컬럼은 " · "로 합쳐서 한 줄로) */
export function buildDisplayFields(map, rowValues, excludeSet) {
    const entries = Object.entries(map)
        .filter(([h]) => !excludeSet.has(h))
        .sort((a, b) => a[1] - b[1]); // 시트 컬럼 순서 유지

    const merged   = [];
    const groupPos = {};
    entries.forEach(([header, colIdx]) => {
        const { group, sub } = parseGroupedHeader(header);
        const val = String(rowValues[colIdx] ?? '').trim();
        if (sub === null) {
            merged.push({ label: group, value: val || '-' });
        } else {
            if (groupPos[group] === undefined) {
                groupPos[group] = merged.length;
                merged.push({ label: group, parts: [] });
            }
            merged[groupPos[group]].parts.push(`${sub} ${val || '0'}`);
        }
    });

    return merged.map(f => f.parts ? { label: f.label, value: f.parts.join(' · ') } : f);
}
