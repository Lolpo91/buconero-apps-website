import { appStoreFetchReport } from './app-store-auth.js';

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function recentDates(days) {
  const dates = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < days; i++) {
    dates.push(formatDateUTC(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  if (!lines.length) return { headers: [], rows: [] };

  const headers = lines[0].split('\t').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split('\t'));
  return { headers, rows };
}

function columnIndex(headers, names) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseNumber(value) {
  if (value == null || value === '') return 0;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

async function loadReport(env, filters) {
  const bytes = await appStoreFetchReport(env, filters);
  if (!bytes || !bytes.length) return null;
  const text = new TextDecoder('utf-8').decode(await gunzip(bytes));
  return parseTsv(text);
}

function aggregateSalesReport(table, appleAppId) {
  if (!table) return { proceeds: 0, units: 0, subscriptionUnits: 0, currency: null };

  const appleIdx = columnIndex(table.headers, ['Apple Identifier', 'Apple ID', 'App Apple ID']);
  const proceedsIdx = columnIndex(table.headers, ['Developer Proceeds', 'Developer Proceeds ']);
  const unitsIdx = columnIndex(table.headers, ['Units', 'Quantity']);
  const currencyIdx = columnIndex(table.headers, ['Currency of Proceeds', 'Customer Currency']);
  const productTypeIdx = columnIndex(table.headers, ['Product Type Identifier', 'Product Type']);
  const subscriptionTypes = new Set(['IA1', 'IAY', 'IAC', 'IAK', 'IAP']);

  let proceeds = 0;
  let units = 0;
  let subscriptionUnits = 0;
  let currency = null;

  for (const row of table.rows) {
    if (appleIdx >= 0 && row[appleIdx] && row[appleIdx] !== appleAppId) continue;

    proceeds += parseNumber(row[proceedsIdx]);
    const rowUnits = parseNumber(row[unitsIdx]);
    units += rowUnits;
    const productType = productTypeIdx >= 0 ? String(row[productTypeIdx] || '').toUpperCase() : '';
    if (subscriptionTypes.has(productType)) subscriptionUnits += rowUnits;
    if (!currency && currencyIdx >= 0) currency = row[currencyIdx] || null;
  }

  return { proceeds, units, subscriptionUnits, currency };
}

function aggregateSubscriptionReport(table, appleAppId) {
  if (!table) return { activeSubscriptions: 0 };

  const appleIdx = columnIndex(table.headers, ['App Apple ID', 'Apple Identifier', 'Apple ID']);
  const activeIdx = columnIndex(table.headers, [
    'Active Standard Price Subscriptions',
    'Active Subscriptions',
    'Active Paid Subscriptions',
  ]);

  let activeSubscriptions = 0;

  for (const row of table.rows) {
    if (appleIdx >= 0 && row[appleIdx] && row[appleIdx] !== appleAppId) continue;
    if (activeIdx >= 0) activeSubscriptions += parseNumber(row[activeIdx]);
  }

  return { activeSubscriptions };
}

export async function fetchAppStoreFinancial(env, appleAppId) {
  const vendorNumber = env.APPLE_VENDOR_NUMBER;
  if (!vendorNumber) {
    return {
      configured: false,
      error:
        'Set APPLE_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports → Vendor ID)',
    };
  }

  const dates = recentDates(31);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStartStr = formatDateUTC(monthStart);

  const salesByDay = [];
  let last30Proceeds = 0;
  let monthProceeds = 0;
  let subscriptionOrders30d = 0;
  let currency = 'USD';
  let activeSubscriptions = 0;

  for (const reportDate of dates) {
    try {
      const table = await loadReport(env, {
        vendorNumber,
        reportType: 'SALES',
        reportSubType: 'SUMMARY',
        frequency: 'DAILY',
        reportDate,
        version: '1_0',
      });
      const stats = aggregateSalesReport(table, appleAppId);
      if (stats.currency) currency = stats.currency;
      last30Proceeds += stats.proceeds;
      subscriptionOrders30d += stats.subscriptionUnits;
      if (reportDate >= monthStartStr) monthProceeds += stats.proceeds;
      if (stats.proceeds > 0) {
        salesByDay.push({ date: reportDate, total: Math.round(stats.proceeds * 100) / 100 });
      }
    } catch {
      /* report may not exist for that day yet */
    }
  }

  for (const reportDate of dates.slice(0, 7)) {
    try {
      const table = await loadReport(env, {
        vendorNumber,
        reportType: 'SUBSCRIPTION',
        reportSubType: 'SUMMARY',
        frequency: 'DAILY',
        reportDate,
        version: '1_3',
      });
      const stats = aggregateSubscriptionReport(table, appleAppId);
      if (stats.activeSubscriptions > 0) {
        activeSubscriptions = stats.activeSubscriptions;
        break;
      }
    } catch {
      /* skip missing days */
    }
  }

  salesByDay.sort((a, b) => a.date.localeCompare(b.date));

  return {
    configured: true,
    currency,
    last30Days: Math.round(last30Proceeds * 100) / 100,
    monthToDate: Math.round(monthProceeds * 100) / 100,
    subscriptionOrders30d,
    activeSubscriptions,
    revenueByDay: salesByDay,
    source: 'sales_reports',
    note: 'Developer proceeds from App Store Connect sales reports (next-day data).',
  };
}
