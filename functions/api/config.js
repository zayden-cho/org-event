/* GET /api/config
   브라우저가 페이지 로드 시 호출
   → 법인 목록, 현장신청 오픈 여부, 참석확인/현장신청 폼에 필요한
     필드 정의(동적 이벤트 필드 + 커스텀 필드)를 함께 반환 */

import { CORPS } from '../_shared/settings.js';
import { getFieldConfig } from '../_shared/logic.js';

export async function onRequest(context) {
    const { env } = context;
    try {
        const { checkinFields, registerFields } = await getFieldConfig(env);
        return Response.json({
            eventTitle:      env.EVENT_TITLE || '행사',
            corps:           CORPS,
            onSiteOpen:      env.ENABLE_ONSITE_REGISTER !== 'false',
            checkinFields,
            registerFields,
        });
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
