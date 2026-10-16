/* API 공용 응답 헬퍼 */

/** 예외 → JSON 에러 응답.
 - 구글 429/5xx처럼 "잠시 뒤 다시 하면 되는" 오류는 503 + retryable:true 로 내려서
 화면(index.html)이 자동 재시도하거나 친절한 안내를 보여줄 수 있게 한다.
 - 그 외 오류는 기존처럼 원인 메시지를 그대로 전달 (/api/config 를 직접 열어 디버깅할 수 있도록) */
export function errorResponse(e) {
    const retryable = !!(e && e.retryable);
    return Response.json(
        {
            status:    'error',
            retryable,
            message:   retryable
                ? '접속자가 많아 처리가 지연되고 있어요. 잠시 후 다시 시도해 주세요.'
                : ((e && e.message) || '알 수 없는 오류가 발생했습니다.'),
        },
        { status: retryable ? 503 : 500, headers: retryable ? { 'Retry-After': '3' } : {} }
    );
}
