const COOKIE_NAME = 'buconero_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = origin && origin.includes('buconeroapps.com');
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

function toBase64Url(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function signSession(env, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + toBase64Url(sig);
}

async function verifySession(env, token) {
  if (!token || !env.SESSION_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sig),
    new TextEncoder().encode(body)
  );
  if (!valid) return null;

  try {
    const jsonStr = new TextDecoder().decode(fromBase64Url(body));
    const payload = JSON.parse(jsonStr);
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookieHeader(token) {
  return COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + SESSION_TTL_SEC;
}

function clearSessionCookieHeader() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}

export async function requireAuth(request, env) {
  const token = getSessionCookie(request);
  const session = await verifySession(env, token);
  if (!session) return null;
  return session;
}

export async function handleAuth(request, env, pathname) {
  const headers = corsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: 'Dashboard not configured on server' }, 503, headers);
    }

    const body = await request.json().catch(() => ({}));
    const password = body.password || '';

    if (!(await safeEqual(password, env.DASHBOARD_PASSWORD))) {
      return json({ error: 'Invalid password' }, 401, headers);
    }

    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
    const token = await signSession(env, { exp });
    headers['Set-Cookie'] = sessionCookieHeader(token);
    return json({ ok: true }, 200, headers);
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    headers['Set-Cookie'] = clearSessionCookieHeader();
    return json({ ok: true }, 200, headers);
  }

  if (pathname === '/api/auth/session' && request.method === 'GET') {
    const session = await requireAuth(request, env);
    if (!session) return json({ error: 'Unauthorized' }, 401, headers);
    return json({ ok: true }, 200, headers);
  }

  return null;
}
