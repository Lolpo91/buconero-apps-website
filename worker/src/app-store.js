import { SignJWT, importPKCS8 } from 'jose';

async function appStoreToken(env) {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' })
    .setIssuer(env.APPLE_ISSUER_ID)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

async function appStoreFetch(env, path) {
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

function aggregateIosReviews(reviews) {
  const stars = [0, 0, 0, 0, 0];
  let total = 0;

  for (const review of reviews) {
    const rating = Number(review.attributes?.rating || 0);
    if (rating >= 1 && rating <= 5) {
      stars[rating - 1] += 1;
      total += rating;
    }
  }

  const count = stars.reduce((a, b) => a + b, 0);
  return {
    reviewCount: count,
    averageRating: count ? total / count : null,
    starDistribution: stars,
  };
}

async function fetchAllIosReviews(env, appId) {
  const reviews = [];
  let next = '/v1/apps/' + appId + '/customerReviews?limit=200';

  while (next && reviews.length < 500) {
    const data = await appStoreFetch(env, next);
    if (Array.isArray(data.data)) reviews.push(...data.data);
    next = data.links?.next ? data.links.next.replace('https://api.appstoreconnect.apple.com', '') : '';
  }

  return reviews;
}

export async function fetchAppStoreMetrics(env) {
  const hasApple =
    env.APPLE_KEY_ID && env.APPLE_ISSUER_ID && env.APPLE_PRIVATE_KEY;

  if (!hasApple) {
    return { configured: false, error: 'Apple API secrets not set' };
  }

  const bundleId = env.APPLE_BUNDLE_ID || 'com.cardgradingai.app';
  const appsData = await appStoreFetch(
    env,
    '/v1/apps?filter[bundleId]=' + encodeURIComponent(bundleId) + '&limit=1'
  );

  const app = appsData.data?.[0];
  if (!app) {
    return { configured: true, bundleId, reviewCount: 0, averageRating: null, starDistribution: [0, 0, 0, 0, 0] };
  }

  const reviews = await fetchAllIosReviews(env, app.id);
  const stats = aggregateIosReviews(reviews);

  return {
    configured: true,
    bundleId,
    appName: app.attributes?.name || bundleId,
    ...stats,
  };
}
