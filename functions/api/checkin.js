/* POST /api/checkin
   요청 body: { corp, phone, fields }
   fields: 참석확인 화면에서 추가로 입력받은 커스텀 필드값
           { 필드명: 값 또는 { 옵션명: 값 } } */

import { checkIn } from '../_shared/logic.js';

export async function onRequestPost(context) {
    try {
        const { corp, phone, fields } = await context.request.json();
        const result = await checkIn(context.env, corp, phone, fields || {});
        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
