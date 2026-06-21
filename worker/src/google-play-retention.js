import { googleAccessToken } from './google-play.js';
import {
  decodeCsvBytes,
  gcsDownloadObject,
  gcsListObjects,
  parseCsv,
} from './google-play-revenue.js';

function columnIndex(headers, names) {
  const lower = headers.map((h) => String(h).trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseRate(value) {
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function parseCount(value) {
  if (value == null || value === '') return 0;
  const n = parseInt(String(value).replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function aggregateRetentionRows(rows) {
  if (!rows.length) return null;

  const header = rows[0].map((h) => String(h).trim());
  const dateIdx = columnIndex(header, ['Date']);
  const installersIdx = columnIndex(header, ['Installers']);
  const d1Idx = columnIndex(header, [
    'Installer-to-1 day retention rate',
    'Installer-to-1 days retention rate',
  ]);
  const d7Idx = columnIndex(header, [
    'Installer-to-7 days retention rate',
    'Installer-to-7 day retention rate',
  ]);
  const d30Idx = columnIndex(header, [
    'Installer-to-30 days retention rate',
    'Installer-to-30 day retention rate',
  ]);

  if (d1Idx < 0 && d7Idx < 0 && d30Idx < 0) {
    throw new Error('Unexpected Play retention report format');
  }

  const recent = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const date = dateIdx >= 0 ? String(row[dateIdx] || '').trim() : '';
    if (!date) continue;
    recent.push({
      date,
      installers: installersIdx >= 0 ? parseCount(row[installersIdx]) : 1,
      d1: d1Idx >= 0 ? parseRate(row[d1Idx]) : null,
      d7: d7Idx >= 0 ? parseRate(row[d7Idx]) : null,
      d30: d30Idx >= 0 ? parseRate(row[d30Idx]) : null,
    });
  }

  recent.sort((a, b) => b.date.localeCompare(a.date));
  const sample = recent.slice(0, 28).filter((row) => row.installers > 0);
  if (!sample.length) return null;

  function weightedAverage(key) {
    let totalWeight = 0;
    let sum = 0;
    for (const row of sample) {
      const value = row[key];
      if (value == null) continue;
      sum += value * row.installers;
      totalWeight += row.installers;
    }
    return totalWeight ? sum / totalWeight : null;
  }

  const d1 = weightedAverage('d1');
  const d7 = weightedAverage('d7');
  const d30 = weightedAverage('d30');

  return {
    day1: d1 != null ? Math.round(d1 * 1000) / 10 : null,
    day7: d7 != null ? Math.round(d7 * 1000) / 10 : null,
    day30: d30 != null ? Math.round(d30 * 1000) / 10 : null,
    retentionByDay: sample
      .filter((row) => row.d1 != null || row.d7 != null || row.d30 != null)
      .map((row) => ({
        date: row.date,
        day1: row.d1 != null ? Math.round(row.d1 * 1000) / 10 : null,
        day7: row.d7 != null ? Math.round(row.d7 * 1000) / 10 : null,
        day30: row.d30 != null ? Math.round(row.d30 * 1000) / 10 : null,
      }))
      .reverse(),
    source: 'retained_installers',
    note: 'Installer retention from Play Console retained installers report (last 28 days, weighted by installers).',
  };
}

async function loadRetentionCsv(token, bucket, objectName) {
  const bytes = await gcsDownloadObject(token, bucket, objectName);
  return parseCsv(decodeCsvBytes(bytes));
}

export async function fetchPlayRetention(env, serviceAccount, packageName) {
  const bucket = env.GOOGLE_PLAY_GCS_BUCKET;
  if (!bucket) {
    return {
      configured: false,
      error: 'Set GOOGLE_PLAY_GCS_BUCKET to load Play retention reports.',
    };
  }

  const token = await googleAccessToken(serviceAccount, [
    'https://www.googleapis.com/auth/devstorage.read_only',
  ]);

  const prefix = `acquisition/retained_installers/retained_installers_${packageName}_`;
  const objects = await gcsListObjects(token, bucket, prefix);
  const reportObjects = objects
    .filter((o) => o.name && o.name.endsWith('_country.csv'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 2);

  if (!reportObjects.length) {
    return {
      configured: true,
      error:
        'No retained installers reports found in the Play GCS bucket. Google Play only exposes this metric if the retained installers export exists for the account.',
    };
  }

  const allRows = [];
  for (const obj of reportObjects) {
    const rows = await loadRetentionCsv(token, bucket, obj.name);
    if (!allRows.length) allRows.push(...rows);
    else allRows.push(...rows.slice(1));
  }

  const stats = aggregateRetentionRows(allRows);
  if (!stats) {
    return { configured: true, error: 'Play retention report had no usable rows.' };
  }

  return { configured: true, ...stats };
}
