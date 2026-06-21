import { SignJWT, importPKCS8 } from 'jose';

export async function appStoreToken(env) {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' })
    .setIssuer(env.APPLE_ISSUER_ID)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

export async function appStoreFetchJson(env, path) {
  const token = await appStoreToken(env);
  const res = await fetch('https://api.appstoreconnect.apple.com' + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.errors?.[0]?.detail || data.errors?.[0]?.title || 'App Store API error');
  }
  return data;
}

export async function appStoreFetchReport(env, filters) {
  const token = await appStoreToken(env);
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set('filter[' + key + ']', value);
  }

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
  });

  if (res.status === 404 || res.status === 410) return null;

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.errors?.[0]?.detail || data.errors?.[0]?.title || 'Sales report request failed');
  }

  return new Uint8Array(await res.arrayBuffer());
}
