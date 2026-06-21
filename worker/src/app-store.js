import { appStoreFetchJson } from './app-store-auth.js';
import { fetchAppStoreRetention } from './app-store-analytics.js';
import {
  fetchAppStoreFinancial,
  fetchAppStoreMonthDaily,
  fetchAppStoreMonthlyRevenue,
} from './app-store-sales.js';

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
    const data = await appStoreFetchJson(env, next);
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
  const appsData = await appStoreFetchJson(
    env,
    '/v1/apps?filter[bundleId]=' + encodeURIComponent(bundleId) + '&limit=1'
  );

  const app = appsData.data?.[0];
  if (!app) {
    return {
      configured: true,
      bundleId,
      reviewCount: 0,
      averageRating: null,
      starDistribution: [0, 0, 0, 0, 0],
      financial: { configured: false, error: 'App not found in App Store Connect' },
    };
  }

  const reviews = await fetchAllIosReviews(env, app.id);
  const stats = aggregateIosReviews(reviews);

  const appContext = {
    appName: app.attributes?.name || bundleId,
    bundleId,
    appSku: app.attributes?.sku || '',
  };

  let financial = { configured: false };
  try {
    financial = await fetchAppStoreFinancial(env, app.id, appContext);
  } catch (err) {
    financial = { configured: false, error: err.message || 'Financial reports failed' };
  }

  let retention = { configured: false };
  try {
    retention = await fetchAppStoreRetention(env, app.id, appContext);
  } catch (err) {
    retention = { configured: false, error: err.message || 'Retention reports failed' };
  }

  return {
    configured: true,
    bundleId,
    appName: app.attributes?.name || bundleId,
    appleAppId: app.id,
    ...stats,
    financial,
    retention,
  };
}

export async function fetchAppStoreRevenueHistory(env) {
  const hasApple =
    env.APPLE_KEY_ID && env.APPLE_ISSUER_ID && env.APPLE_PRIVATE_KEY;

  if (!hasApple) {
    return { configured: false, error: 'Apple API secrets not set' };
  }

  const bundleId = env.APPLE_BUNDLE_ID || 'com.cardgradingai.app';
  const appsData = await appStoreFetchJson(
    env,
    '/v1/apps?filter[bundleId]=' + encodeURIComponent(bundleId) + '&limit=1'
  );

  const app = appsData.data?.[0];
  if (!app) {
    return { configured: false, error: 'App not found in App Store Connect' };
  }

  return fetchAppStoreMonthlyRevenue(env, app.id, {
    appName: app.attributes?.name || bundleId,
    bundleId,
    appSku: app.attributes?.sku || '',
  });
}

export async function fetchAppStoreMonthDailyRevenue(env, month) {
  const hasApple =
    env.APPLE_KEY_ID && env.APPLE_ISSUER_ID && env.APPLE_PRIVATE_KEY;

  if (!hasApple) {
    return { configured: false, error: 'Apple API secrets not set' };
  }

  const bundleId = env.APPLE_BUNDLE_ID || 'com.cardgradingai.app';
  const appsData = await appStoreFetchJson(
    env,
    '/v1/apps?filter[bundleId]=' + encodeURIComponent(bundleId) + '&limit=1'
  );

  const app = appsData.data?.[0];
  if (!app) {
    return { configured: false, error: 'App not found in App Store Connect' };
  }

  return fetchAppStoreMonthDaily(env, app.id, {
    appName: app.attributes?.name || bundleId,
    bundleId,
    appSku: app.attributes?.sku || '',
  }, month);
}
