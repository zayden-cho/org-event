/* POST /api/register
   요청 body: { corp, ldap, name, phone, fields }
   fields: 현장신청 화면에서 입력받은 모든 필드값
           (동적 이벤트 필드 + 커스텀 필드, { 필드명: 값 또는 { 옵션명: 값 } }) */

import { onSiteRegister } from '../_shared/logic.js';

export async function onRequestPost(context) {
    try {
        const { corp, ldap, name, phone, fields } = await context.request.json();
        const result = await onSiteRegister(context.env, corp, ldap, name, phone, fields || {});
        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
