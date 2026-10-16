/* GET /api/config
   브라우저가 페이지 로드 시 호출
   → 법인 목록, 현장신청 오픈 여부, 참석확인/현장신청 폼에 필요한
     필드 정의(동적 이벤트 필드 + 커스텀 필드)를 함께 반환

   성능: 접속이 몰릴 때 모든 방문자가 이 API를 호출하므로
         Cloudflare 엣지 캐시(30초)로 대부분의 요청을 함수 실행 없이 응답한다. */

import { CORPS } from '../_shared/settings.js';
import { getFieldConfig } from '../_shared/logic.js';
import { errorResponse } from '../_shared/http.js';

const EDGE_TTL_SEC = 30;

export async function onRequest(context) {
    const { env, request } = context;
    const cache = (typeof caches !== 'undefined') ? caches.default : null;

    try { if (cache) { const hit = await cache.match(request); if (hit) return hit; } } catch { /* 캐시 미지원 환경 */ }

    try {
        const { checkinFields, registerFields } = await getFieldConfig(env);
        const res = Response.json(
            {
                eventTitle:      env.EVENT_TITLE || '행사',
                corps:           CORPS,
                onSiteOpen:      env.ENABLE_ONSITE_REGISTER !== 'false',
                checkinFields,
                registerFields,
            },
            { headers: { 'Cache-Control': `public, max-age=${EDGE_TTL_SEC}` } }   // 성공 응답만 캐시
        );
        if (cache && context.waitUntil) context.waitUntil(cache.put(request, res.clone()).catch(() => {}));
        return res;
    } catch (e) {
        return errorResponse(e);
    }
}
