// GitHub App auth: webhook signatures, the app JWT, installation tokens. node:crypto only.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

// X-Hub-Signature-256: "sha256=" + HMAC-SHA256(secret, raw body)
export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// RS256 JWT for /app endpoints. iat is backdated 60 s for clock drift; GitHub allows at most 10 min.
export function appJwt(appId, privateKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat, exp: iat + 540, iss: String(appId) })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

// Env often carries a PEM with literal "\n"; accept that, or base64 of the PEM.
export function normalizeKey(raw) {
  if (!raw) return '';
  let key = raw.trim();
  if (!key.includes('-----BEGIN')) {
    try {
      key = Buffer.from(key, 'base64').toString('utf8').trim();
    } catch {
      return '';
    }
  }
  return key.replace(/\\n/g, '\n').trim();
}

// Installation tokens, cached until 5 minutes before they expire.
export function installationTokens({ appId, privateKey, fetch = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  return async function tokenFor(installationId) {
    const hit = cache.get(installationId);
    if (hit && hit.expiresAt - 5 * 60_000 > now()) return hit.token;
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt(appId, privateKey, now())}`,
        'User-Agent': 'commit-live-app',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`installation token for ${installationId}: HTTP ${res.status}`);
    const body = await res.json();
    cache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  };
}
