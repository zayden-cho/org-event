import {
    adminVerifyPin,
    adminScanQR,
    preloadResponseCache,
    invalidateCache,
    getCacheStatus,
    buildResultSheet,
} from '../_shared/logic.js';

export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const { action, pin } = body;

        let result;

        if (action === 'verifyAndConfig') {
            result = adminVerifyPin(context.env, pin);

        } else if (action === 'scanQR') {
            result = await adminScanQR(context.env, body.qr, pin);

        } else if (action === 'cacheStatus') {
            /* 캐시 상태 조회 (PIN 없이도 가능) */
            result = await getCacheStatus(context.env);

        } else if (action === 'preloadCache') {
            const verify = adminVerifyPin(context.env, pin);
            if (verify.status !== 'ok') return Response.json(verify);
            result = await preloadResponseCache(context.env);

        } else if (action === 'invalidateCache') {
            const verify = adminVerifyPin(context.env, pin);
            if (verify.status !== 'ok') return Response.json(verify);
            result = await invalidateCache(context.env);

        } else if (action === 'buildResult') {
            /* 결과 시트 온디맨드 재계산 (응답 vs 참석확인 diff + 현장신청 조합원매칭분) */
            const verify = adminVerifyPin(context.env, pin);
            if (verify.status !== 'ok') return Response.json(verify);
            result = await buildResultSheet(context.env);

        } else {
            result = { status: 'error', message: '알 수 없는 요청입니다.' };
        }

        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
