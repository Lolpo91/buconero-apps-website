import { appStoreFetchJson } from './app-store-auth.js';

function columnIndex(headers, names) {
  const lower = headers.map((h) => String(h).trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parsePercent(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/%/g, '').trim();
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n : n * 100;
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split('\t').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split('\t'));
  return { headers, rows };
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function downloadSegment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to download analytics report segment');
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(await gunzip(bytes));
  return parseTsv(text);
}

async function ensureOngoingReportRequest(env, appId) {
  const existing = await appStoreFetchJson(
    env,
    '/v1/apps/' + appId + '/analyticsReportRequests?filter[accessType]=ONGOING&limit=1'
  );
  const request = existing.data?.[0];
  if (request?.id) return request.id;

  try {
    const created = await appStoreFetchJson(env, '/v1/analyticsReportRequests', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'analyticsReportRequests',
          attributes: { accessType: 'ONGOING' },
          relationships: {
            app: { data: { type: 'apps', id: appId } },
          },
        },
      }),
    });
    return created.data?.id || null;
  } catch (err) {
    throw new Error(
      err.message ||
        'Could not create Analytics report request. An Admin API key may be required the first time.'
    );
  }
}

async function listReports(env, requestId) {
  const reports = [];
  let next =
    '/v1/analyticsReportRequests/' +
    requestId +
    '/reports?limit=200&fields[analyticsReports]=name,category';

  while (next) {
    const data = await appStoreFetchJson(env, next);
    if (Array.isArray(data.data)) reports.push(...data.data);
    next = data.links?.next
      ? data.links.next.replace('https://api.appstoreconnect.apple.com', '')
      : '';
  }

  return reports;
}

function pickRetentionReport(reports) {
  const candidates = reports.filter((report) => {
    const name = String(report.attributes?.name || '').toLowerCase();
    if (!name.includes('retention')) return false;
    if (name.includes('messaging')) return false;
    return true;
  });

  return (
    candidates.find((report) => /app retention/i.test(report.attributes?.name || '')) ||
    candidates.find((report) => /subscription retention/i.test(report.attributes?.name || '')) ||
    candidates[0] ||
    null
  );
}

async function latestReportInstance(env, reportId) {
  const data = await appStoreFetchJson(
    env,
    '/v1/analyticsReports/' + reportId + '/instances?filter[granularity]=DAILY&limit=10'
  );
  const instances = (data.data || []).sort((a, b) => {
    const aDate = a.attributes?.processingDate || '';
    const bDate = b.attributes?.processingDate || '';
    return bDate.localeCompare(aDate);
  });
  return instances[0] || null;
}

async function downloadLatestInstance(env, reportId) {
  const instance = await latestReportInstance(env, reportId);
  if (!instance?.id) return null;

  const segmentsData = await appStoreFetchJson(
    env,
    '/v1/analyticsReportInstances/' + instance.id + '/segments'
  );
  const segments = segmentsData.data || [];
  if (!segments.length) return null;

  let combined = { headers: [], rows: [] };
  for (const segment of segments) {
    const url = segment.attributes?.url;
    if (!url) continue;
    const table = await downloadSegment(url);
    if (!combined.headers.length) combined = table;
    else if (table.rows.length) combined.rows.push(...table.rows);
  }

  return combined.rows.length ? combined : null;
}

function extractRetentionFromTable(table, appleAppId, appName) {
  if (!table || !table.rows.length) return null;

  const headers = table.headers;
  const appIdIdx = columnIndex(headers, ['App Apple Identifier', 'Apple Identifier', 'Apple ID']);
  const appNameIdx = columnIndex(headers, ['App Name', 'Application']);
  const dateIdx = columnIndex(headers, ['Date', 'Cohort Date', 'Install Day', 'Start Date']);
  const d1Idx = columnIndex(headers, [
    'Day 1 Retention',
    'Day 1',
    'D1 Retention',
    'Retention Day 1',
    '1 Day Retention',
  ]);
  const d7Idx = columnIndex(headers, [
    'Day 7 Retention',
    'Day 7',
    'D7 Retention',
    'Retention Day 7',
    '7 Day Retention',
  ]);
  const d28Idx = columnIndex(headers, [
    'Day 28 Retention',
    'Day 28',
    'D28 Retention',
    'Retention Day 28',
    '28 Day Retention',
    'Day 30 Retention',
    'Day 30',
    'D30 Retention',
  ]);

  const retentionByDay = [];
  let latest = null;

  for (const row of table.rows) {
    if (appIdIdx >= 0 && row[appIdIdx] && String(row[appIdIdx]) !== String(appleAppId)) continue;
    if (appNameIdx >= 0 && appName) {
      const value = String(row[appNameIdx] || '').toLowerCase();
      if (value && !value.includes(appName.toLowerCase())) continue;
    }

    const day1 = d1Idx >= 0 ? parsePercent(row[d1Idx]) : null;
    const day7 = d7Idx >= 0 ? parsePercent(row[d7Idx]) : null;
    const day28 = d28Idx >= 0 ? parsePercent(row[d28Idx]) : null;
    const date = dateIdx >= 0 ? String(row[dateIdx] || '').trim() : '';

    if (day1 == null && day7 == null && day28 == null) continue;

    const entry = {
      date,
      day1,
      day7,
      day28,
      day30: day28,
    };
    retentionByDay.push(entry);
    if (!latest || (date && date > (latest.date || ''))) latest = entry;
  }

  if (!latest) return null;

  return {
    day1: latest.day1,
    day7: latest.day7,
    day28: latest.day28,
    day30: latest.day28,
    retentionByDay: retentionByDay
      .filter((row) => row.date)
      .sort((a, b) => a.date.localeCompare(b.date)),
    source: 'analytics_reports',
    note: 'User retention from App Store Connect Analytics reports (opt-in users only).',
  };
}

export async function fetchAppStoreRetention(env, appleAppId, appContext = {}) {
  const hasApple =
    env.APPLE_KEY_ID && env.APPLE_ISSUER_ID && env.APPLE_PRIVATE_KEY;

  if (!hasApple) {
    return { configured: false, error: 'Apple API secrets not set' };
  }

  try {
    const requestId = await ensureOngoingReportRequest(env, appleAppId);
    if (!requestId) {
      return {
        configured: false,
        error: 'Analytics report request not available yet. It can take 24–48 hours after setup.',
      };
    }

    const reports = await listReports(env, requestId);
    const retentionReport = pickRetentionReport(reports);
    if (!retentionReport?.id) {
      return {
        configured: false,
        error:
          'No retention analytics report found yet. Enable App Analytics in App Store Connect and wait for the first ONGOING reports.',
      };
    }

    const table = await downloadLatestInstance(env, retentionReport.id);
    const stats = extractRetentionFromTable(table, appleAppId, appContext.appName || '');
    if (!stats) {
      return {
        configured: true,
        error: 'Retention report downloaded but no matching rows were found for this app yet.',
      };
    }

    return { configured: true, reportName: retentionReport.attributes?.name || 'Retention', ...stats };
  } catch (err) {
    return { configured: false, error: err.message || 'App Store retention fetch failed' };
  }
}
