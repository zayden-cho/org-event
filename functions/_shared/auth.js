/* Google Service Account → Access Token
   Web Crypto API 사용 — npm 패키지 불필요 */

let _tokenCache  = null;
let _tokenExpiry = 0;

function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function b64url(str) {
    return btoa(str).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlBuf(buf) {
    let str = '';
    new Uint8Array(buf).forEach(b => str += String.fromCharCode(b));
    return b64url(str);
}

const KV_TOKEN_KEY = 'google_access_token';
let _tokenInflight = null;

/** 서비스 계정 액세스 토큰 발급.
 - 같은 isolate: 메모리 캐시 + "동시에 들어온 요청은 1번의 발급에 합류"(콜드스타트 폭주 방지)
 - 다른 isolate: kv(선택)에 토큰을 공유해서, 새 isolate가 뜰 때마다 RSA 서명+OAuth 호출을
 반복하지 않게 한다 (트래픽이 몰리면 isolate가 많이 생기므로 효과가 큼)
 - 발급 실패 시 예전처럼 조용히 undefined를 캐시하지 않고 명확한 에러를 던진다 */
export async function getAccessToken(email, privateKeyPem, kv) {
    if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;
    if (_tokenInflight) return _tokenInflight;

    _tokenInflight = (async () => {
        if (kv) {
            try {
                const shared = await kv.get(KV_TOKEN_KEY, 'json');
                if (shared && shared.token && Date.now() < shared.exp) {
                    _tokenCache = shared.token; _tokenExpiry = shared.exp;
                    return _tokenCache;
                }
            } catch { /* KV 오류는 무시하고 직접 발급 */ }
        }

        const now    = Math.floor(Date.now() / 1000);
        const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const claim  = b64url(JSON.stringify({
            iss:   email,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            aud:   'https://oauth2.googleapis.com/token',
            exp:   now + 3600,
            iat:   now,
        }));

        const message = `${header}.${claim}`;
        const key = await crypto.subtle.importKey(
            'pkcs8', pemToDer(privateKeyPem),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false, ['sign']
        );
        const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));
        const jwt = `${message}.${b64urlBuf(sig)}`;

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
        });
        if (!res.ok) throw new Error(`Google 토큰 발급 실패 (${res.status}): ${await res.text()}`);
        const { access_token, expires_in } = await res.json();
        if (!access_token) throw new Error('Google 토큰 발급 실패: access_token이 비어 있습니다.');

        _tokenCache  = access_token;
        _tokenExpiry = Date.now() + (expires_in - 120) * 1000;

        if (kv) {
            try {
                /* KV 최소 TTL은 60초. 만료 5분 전에 자연 폐기되도록 설정 */
                await kv.put(KV_TOKEN_KEY, JSON.stringify({ token: _tokenCache, exp: _tokenExpiry }),
                    { expirationTtl: Math.max(60, expires_in - 300) });
            } catch { /* KV 쓰기 실패는 치명적이지 않음 */ }
        }
        return _tokenCache;
    })().finally(() => { _tokenInflight = null; });

    return _tokenInflight;
}
