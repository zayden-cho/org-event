/* ============================================================
   고정 설정값 — 법인 목록 / 시트 이름 / 상태 라벨 / 공용 유틸
   ------------------------------------------------------------
   기존에 있던 FEATURES(enableMeal, enableSchedule 등) 하드코딩은
   전부 제거되었습니다. 식사여부/참여일정 같은 필드는 이제
   "필드설정" / "필드옵션" 스프레드시트 탭에서 관리하는
   동적 이벤트 필드 또는 커스텀 필드로 다뤄집니다.
   (관련 로직: fields.js)
   ============================================================ */

export const CORPS = [
    '그립컴퍼니',
    '다음',
    '디케이테크인',
    '링키지랩',
    '볼트업',
    '서울아레나',
    '야나두',
    '엑스엘게임즈',
    '카카오',
    '카카오게임즈',
    '카카오모빌리티',
    '카카오뱅크',
    '카카오스타일',
    '카카오엔터테인먼트',
    '카카오엔터프라이즈',
    '카카오임팩트',
    '카카오페이',
    '카카오페이증권',
    '카카오헬스케어',
    '카카오VX',
    '케이드라이브',
    '케이앤웍스',
    '케이엠파크',
    '키이스트',
    'KP보험서비스',
    'SM엔터테인먼트',
    'SMC&C',
    '기타 법인',
];

/* 고정 시트 탭 이름 — 외부에서 만들어지는 시트(응답 폼, 크루유니언 DB)만 여기 둔다.
 코드가 직접 쓰는 시트(출석/현장/결과)는 테스트용 탭을 따로 쓸 수 있도록
 전부 환경변수로 뺐다 (CHECKIN_SHEET_NAME / ONSITE_SHEET_NAME / RESULT_SHEET_NAME) */
export const SHEET_NAMES = {
    RESPONSE:  '응답',
    KREWUNION: '크루유니언',
};

/* 위 세 환경변수를 안 넣었을 때 쓰는 기본값 (기존 하드코딩 값과 동일) */
export const DEFAULT_SHEET_NAMES = {
    CHECKIN: '테스트',
    ONSITE:  '현장',
    RESULT:  '결과',
};

/* 응답 시트의 원본 "참여상태" 값 (외부 신청폼/운영진이 직접 입력, 그대로 참고만 함) */
export const RESPONSE_STATUS = {
    CANCEL:          '참여취소',
    SAME_DAY_CANCEL: '당일취소',
};

/* 결과 시트에 기록할 최종 상태 라벨 */
export const RESULT_STATUS = {
    PRE_CANCEL:      '사전취소',
    SAME_DAY_CANCEL: '당일취소',
    ATTEND:          '출석',
    NO_SHOW:         '노쇼',
    ONSITE:          '현장참여',
};

/* 현장 시트 Index 컬럼에서, 조합원 매칭이 안 됐을 때 표시하는 값 */
export const NO_MATCH_LABEL = '일치없음';

export function normalizePhone(p) { return String(p).replace(/[^0-9]/g, ''); }

export function formatPhone(p) {
    const d = String(p).replace(/[^0-9]/g, '');
    if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
    if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
    return d;
}

export function nowKST() {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
}
