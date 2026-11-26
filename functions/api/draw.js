/* POST /api/draw   (운영진 PIN 필요)
   action: 'candidates' → 추첨 후보(출석/현장참여) + 사람별 구슬수 + 이미 당첨된 사람
           'save'       → 추첨 결과 기록 (추첨기록 시트)
           'replay'     → 추첨ID로 시드/조건/참가 구슬 목록 조회 (같은 추첨을 다시 돌려보기)
   body: { action, pin, refresh?, record?, drawId? } */

import { getDrawCandidates, saveDrawRecord, getDrawReplay } from '../_shared/draw.js';
import { errorResponse } from '../_shared/http.js';

export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const { action, pin } = body;

        let result;
        if (action === 'candidates') {
            result = await getDrawCandidates(context.env, pin, !!body.refresh);
        } else if (action === 'save') {
            result = await saveDrawRecord(context.env, pin, body.record);
        } else if (action === 'replay') {
            result = await getDrawReplay(context.env, pin, body.drawId);
        } else {
            result = { status: 'error', message: '알 수 없는 요청입니다.' };
        }
        return Response.json(result);
    } catch (e) {
        return errorResponse(e);
    }
}
