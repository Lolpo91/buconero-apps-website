function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(bytes) {
  const str = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function googleAccessToken(serviceAccount, extraScopes) {
  const scopes = extraScopes || [
    'https://www.googleapis.com/auth/androidpublisher',
    'https://www.googleapis.com/auth/playdeveloperreporting',
  ];
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const claimEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim)));
  const unsigned = header + '.' + claimEncoded;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = unsigned + '.' + base64UrlEncode(signature);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Google auth failed');
  }
  return data.access_token;
}

export { googleAccessToken };

function aggregateReviews(reviews) {
  const stars = [0, 0, 0, 0, 0];
  let total = 0;

  for (const review of reviews) {
    const rating = Number(review.comments?.[0]?.userComment?.starRating || review.starRating || 0);
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

async function fetchAllPlayReviews(token, packageName) {
  const reviews = [];
  let pageToken = '';

  do {
    const url = new URL(
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        encodeURIComponent(packageName) + '/reviews'
    );
    if (pageToken) url.searchParams.set('token', pageToken);
    url.searchParams.set('maxResults', '100');

    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
    });

    if (res.status === 404) return reviews;
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error?.message || 'Play reviews request failed');
    }

    if (Array.isArray(data.reviews)) reviews.push(...data.reviews);
    pageToken = data.tokenPagination?.nextPageToken || '';
  } while (pageToken && reviews.length < 500);

  return reviews;
}

async function fetchPlayCrashRate(token, packageName) {
  const appName = 'apps/' + packageName;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  const body = {
    metrics: ['crashRate'],
    dimensions: ['versionCode'],
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate() },
      endTime: { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate() },
    },
  };

  const res = await fetch(
    'https://playdeveloperreporting.googleapis.com/v1beta1/' + appName + '/crashRateMetricSet:query',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  const rows = data.rows || [];
  if (!rows.length) return null;

  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const val = Number(row.metrics?.[0]?.decimalValue?.value);
    if (!Number.isNaN(val)) {
      sum += val * 100;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

export async function fetchPlayMetrics(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { configured: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON secret not set' };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    return { configured: false, error: 'Invalid GOOGLE_SERVICE_ACCOUNT_JSON' };
  }

  const packageName = env.PLAY_PACKAGE_NAME || 'com.gradeai.yourapp';
  const token = await googleAccessToken(serviceAccount);
  const reviews = await fetchAllPlayReviews(token, packageName);
  const stats = aggregateReviews(reviews);
  const crashRate7d = await fetchPlayCrashRate(token, packageName);

  return {
    configured: true,
    packageName,
    ...stats,
    crashRate7d,
  };
}
