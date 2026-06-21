import { googleAccessToken } from './google-play.js';

function parseAmount(value) {
  if (value == null || value === '') return 0;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function decodeCsvBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function unzipFirstCsv(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let offset = 0;

  while (offset + 30 <= zipBytes.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;

    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(zipBytes.subarray(nameStart, nameStart + fileNameLength));

    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const payload = zipBytes.subarray(dataStart, dataEnd);

    if (name.endsWith('.csv')) {
      if (compression === 0) return decodeCsvBytes(payload);
      if (compression === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([payload]).stream().pipeThrough(ds);
        return decodeCsvBytes(new Uint8Array(await new Response(stream).arrayBuffer()));
      }
    }

    offset = dataEnd;
  }

  throw new Error('No CSV file found inside Play sales report zip');
}

async function gcsListObjects(token, bucket, prefix) {
  const items = [];
  let pageToken = '';

  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error?.message || 'Cloud Storage list failed');
    }

    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

async function gcsDownloadObject(token, bucket, objectName) {
  const url =
    'https://storage.googleapis.com/storage/v1/b/' +
    encodeURIComponent(bucket) +
    '/o/' +
    encodeURIComponent(objectName).replace(/%2F/g, '/') +
    '?alt=media';

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Cloud Storage download failed');
  }
  return new Uint8Array(await res.arrayBuffer());
}

function aggregateSalesRows(rows, packageName) {
  const header = rows[0].map((h) => String(h).trim());
  const idx = {
    packageId: header.indexOf('Package ID'),
    status: header.indexOf('Financial Status'),
    chargedDate: header.indexOf('Order Charged Date'),
    productType: header.indexOf('Product Type'),
    amount: header.indexOf('Charged Amount'),
    currency: header.indexOf('Currency of Sale'),
  };

  if (idx.packageId < 0 || idx.amount < 0) {
    throw new Error('Unexpected Play sales report format');
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const day30 = new Date(now);
  day30.setUTCDate(day30.getUTCDate() - 30);

  let monthTotal = 0;
  let last30Total = 0;
  let subscriptionOrders = 0;
  const daily = {};
  const currencyCounts = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < header.length) continue;
    if (row[idx.packageId] !== packageName) continue;

    const status = String(row[idx.status] || '').toLowerCase();
    const amount = parseAmount(row[idx.amount]);
    const sign = status.includes('refund') ? -1 : 1;
    const value = amount * sign;
    const currency = row[idx.currency] || 'MIXED';
    currencyCounts[currency] = (currencyCounts[currency] || 0) + 1;

    const dateStr = row[idx.chargedDate];
    const date = dateStr ? new Date(dateStr + 'T00:00:00Z') : null;
    if (date && !Number.isNaN(date.getTime())) {
      if (date >= day30) {
        last30Total += value;
        const key = dateStr;
        daily[key] = (daily[key] || 0) + value;
      }
      if (date >= monthStart) {
        monthTotal += value;
      }
    }

    if (idx.productType >= 0) {
      const type = String(row[idx.productType] || '').toLowerCase();
      if (type.includes('subscription') && sign > 0) subscriptionOrders += 1;
    }
  }

  const dominantCurrency =
    Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const revenueByDay = Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date, total: Math.round(total * 100) / 100 }));

  return {
    currency: dominantCurrency,
    monthToDate: Math.round(monthTotal * 100) / 100,
    last30Days: Math.round(last30Total * 100) / 100,
    subscriptionOrders30d: subscriptionOrders,
    revenueByDay,
    source: 'estimated_sales',
    note: 'Estimated sales (buyer amounts, before Google fees and taxes). Not for accounting.',
  };
}

async function loadSalesReport(token, bucket, objectName) {
  const bytes = await gcsDownloadObject(token, bucket, objectName);
  const csvText = objectName.endsWith('.zip')
    ? await unzipFirstCsv(bytes)
    : decodeCsvBytes(bytes);
  return parseCsv(csvText);
}

export async function fetchPlayRevenue(env, serviceAccount, packageName) {
  const bucket = env.GOOGLE_PLAY_GCS_BUCKET;
  if (!bucket) {
    return {
      configured: false,
      error: 'Set GOOGLE_PLAY_GCS_BUCKET (pubsite_prod_rev_…) from Play Console → Download reports → Financial',
    };
  }

  const token = await googleAccessToken(serviceAccount, [
    'https://www.googleapis.com/auth/devstorage.read_only',
  ]);

  const objects = await gcsListObjects(token, bucket, 'sales/salesreport_');
  const reportObjects = objects
    .filter((o) => o.name && /sales\/salesreport_\d{6}\.zip$/.test(o.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 3);

  if (!reportObjects.length) {
    return {
      configured: true,
      error: 'No sales reports found in bucket yet. Google posts them within a few days.',
    };
  }

  const allRows = [];
  for (const obj of reportObjects) {
    const rows = await loadSalesReport(token, bucket, obj.name);
    if (!allRows.length) allRows.push(...rows);
    else allRows.push(...rows.slice(1));
  }

  const stats = aggregateSalesRows(allRows, packageName);
  return { configured: true, ...stats };
}
