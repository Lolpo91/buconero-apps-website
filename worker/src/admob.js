function requiredSecrets(env) {
  return [
    'ADMOB_ACCOUNT_ID',
    'ADMOB_CLIENT_ID',
    'ADMOB_CLIENT_SECRET',
    'ADMOB_REFRESH_TOKEN',
  ].filter((key) => !env[key]);
}

function dateParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseAdMobDate(value) {
  const raw = String(value || '');
  if (/^\d{8}$/.test(raw)) {
    return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
  }
  return raw;
}

function microsToMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n / 1000000 : 0;
}

function accountName(accountId) {
  const raw = String(accountId || '').trim();
  if (!raw) return '';
  return raw.startsWith('accounts/') ? raw : 'accounts/' + raw;
}

async function admobAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.ADMOB_CLIENT_ID,
      client_secret: env.ADMOB_CLIENT_SECRET,
      refresh_token: env.ADMOB_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'AdMob token refresh failed');
  }

  return data.access_token;
}

function metricValue(metrics, key) {
  const metric = metrics?.[key] || {};
  return (
    metric.microsValue ??
    metric.integerValue ??
    metric.doubleValue ??
    metric.value ??
    0
  );
}

function normalizeReportResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.reports)) return data.reports;
  return [];
}

async function generateNetworkReport(env, startDate, endDate) {
  const token = await admobAccessToken(env);
  const parent = accountName(env.ADMOB_ACCOUNT_ID);
  const res = await fetch('https://admob.googleapis.com/v1/' + parent + '/networkReport:generate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      report_spec: {
        date_range: {
          start_date: dateParts(startDate),
          end_date: dateParts(endDate),
        },
        dimensions: ['DATE'],
        metrics: [
          'ESTIMATED_EARNINGS',
          'IMPRESSIONS',
          'CLICKS',
          'AD_REQUESTS',
          'MATCHED_REQUESTS',
        ],
        sort_conditions: [{ dimension: 'DATE', order: 'ASCENDING' }],
        localization_settings: {
          currency_code: env.ADMOB_CURRENCY || 'USD',
          language_code: 'en-US',
        },
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || 'AdMob report request failed');
  }

  return normalizeReportResponse(data);
}

function aggregateReportRows(rows, monthStartKey, last30StartKey) {
  const daily = new Map();

  for (const item of rows) {
    const row = item.row;
    if (!row) continue;

    const date = parseAdMobDate(row.dimensionValues?.DATE?.value);
    if (!date) continue;

    const metrics = row.metricValues || {};
    const current = daily.get(date) || {
      date,
      total: 0,
      impressions: 0,
      clicks: 0,
      adRequests: 0,
      matchedRequests: 0,
    };

    current.total += microsToMoney(metricValue(metrics, 'ESTIMATED_EARNINGS'));
    current.impressions += Number(metricValue(metrics, 'IMPRESSIONS') || 0);
    current.clicks += Number(metricValue(metrics, 'CLICKS') || 0);
    current.adRequests += Number(metricValue(metrics, 'AD_REQUESTS') || 0);
    current.matchedRequests += Number(metricValue(metrics, 'MATCHED_REQUESTS') || 0);
    daily.set(date, current);
  }

  const revenueByDay = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last30Days = revenueByDay
    .filter((item) => item.date >= last30StartKey)
    .reduce((sum, item) => sum + item.total, 0);
  const monthToDate = revenueByDay
    .filter((item) => item.date >= monthStartKey)
    .reduce((sum, item) => sum + item.total, 0);
  const impressions30d = revenueByDay
    .filter((item) => item.date >= last30StartKey)
    .reduce((sum, item) => sum + item.impressions, 0);
  const clicks30d = revenueByDay
    .filter((item) => item.date >= last30StartKey)
    .reduce((sum, item) => sum + item.clicks, 0);
  const adRequests30d = revenueByDay
    .filter((item) => item.date >= last30StartKey)
    .reduce((sum, item) => sum + item.adRequests, 0);

  const byMonth = new Map();
  for (const item of revenueByDay) {
    const month = item.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + item.total);
  }

  return {
    last30Days,
    monthToDate,
    impressions30d,
    clicks30d,
    adRequests30d,
    revenueByDay,
    revenueByMonth: [...byMonth.entries()]
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

export async function fetchAdMobMetrics(env) {
  const missing = requiredSecrets(env);
  if (missing.length) {
    return {
      configured: false,
      error: 'Set ' + missing.join(', ') + ' to load AdMob ad revenue.',
    };
  }

  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const last30Start = new Date(endDate);
  last30Start.setUTCDate(last30Start.getUTCDate() - 29);
  const monthStart = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  const startDate = monthStart < last30Start ? monthStart : last30Start;

  const rows = await generateNetworkReport(env, startDate, endDate);
  const stats = aggregateReportRows(rows, dateKey(monthStart), dateKey(last30Start));

  return {
    configured: true,
    accountId: env.ADMOB_ACCOUNT_ID,
    currency: env.ADMOB_CURRENCY || 'USD',
    note: 'Estimated AdMob earnings before final adjustments.',
    ...stats,
  };
}
