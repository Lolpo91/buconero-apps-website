import { appStoreFetchReport } from './app-store-auth.js';

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function formatMonthUTC(date) {
  return date.toISOString().slice(0, 7);
}

function recentClosedMonths(months) {
  const result = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() - 1);

  for (let i = 0; i < months; i++) {
    result.push(formatMonthUTC(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }

  return result;
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

function normalizeAppleId(value) {
  if (value == null || value === '') return '';
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? String(n) : String(value).trim();
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
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

function rowMatchesApp(row, headers, { appleAppId, appName, bundleId, appSku }) {
  const appleIdx = columnIndex(headers, ['Apple Identifier', 'Apple ID', 'App Apple ID']);
  const parentIdx = columnIndex(headers, ['Parent Identifier', 'Parent Apple ID']);
  const appIdx = columnIndex(headers, ['Application', 'App Name', 'Title']);
  const skuIdx = columnIndex(headers, ['SKU']);
  const bundleIdx = columnIndex(headers, ['Bundle ID']);

  const targetId = normalizeAppleId(appleAppId);
  const parentId = parentIdx >= 0 ? normalizeAppleId(row[parentIdx]) : '';
  const rowAppleId = appleIdx >= 0 ? normalizeAppleId(row[appleIdx]) : '';
  const parentIdentifier = parentIdx >= 0 ? normalizeText(row[parentIdx]) : '';
  const appIdentifiers = [bundleId, appSku].map(normalizeText).filter(Boolean);

  if (targetId && (rowAppleId === targetId || parentId === targetId)) return true;
  if (parentIdentifier && appIdentifiers.includes(parentIdentifier)) return true;

  if (appName && appIdx >= 0) {
    const application = normalizeText(row[appIdx]);
    if (application && application.includes(normalizeText(appName))) return true;
  }

  if (bundleId && bundleIdx >= 0) {
    const rowBundle = String(row[bundleIdx] || '').trim();
    if (rowBundle === bundleId) return true;
  }

  if (appSku && skuIdx >= 0) {
    const rowSku = String(row[skuIdx] || '').trim();
    if (rowSku === appSku) return true;
  }

  return false;
}

function aggregateSalesReport(table, appContext) {
  if (!table || !table.rows.length) {
    return { proceeds: 0, units: 0, subscriptionUnits: 0, currency: null, matchedRows: 0 };
  }

  const proceedsIdx = columnIndex(table.headers, ['Developer Proceeds', 'Developer Proceeds ']);
  const unitsIdx = columnIndex(table.headers, ['Units', 'Quantity']);
  const currencyIdx = columnIndex(table.headers, [
    'Currency of Proceeds',
    'Proceeds Currency',
    'Developer Proceeds Currency',
  ]);
  const productTypeIdx = columnIndex(table.headers, ['Product Type Identifier', 'Product Type']);
  const subscriptionTypes = new Set(['IA1', 'IAY', 'IAC', 'IAK', 'IAP', 'IAP1']);
  const targetCurrency = normalizeCurrency(appContext.currency || 'USD');

  let proceeds = 0;
  let units = 0;
  let subscriptionUnits = 0;
  let currency = null;
  let matchedRows = 0;

  for (const row of table.rows) {
    if (!rowMatchesApp(row, table.headers, appContext)) continue;

    const rowCurrency = currencyIdx >= 0 ? normalizeCurrency(row[currencyIdx]) : '';
    if (targetCurrency && rowCurrency && rowCurrency !== targetCurrency) continue;

    matchedRows += 1;
    proceeds += parseNumber(row[proceedsIdx]);
    const rowUnits = parseNumber(row[unitsIdx]);
    units += rowUnits;
    const productType = productTypeIdx >= 0 ? String(row[productTypeIdx] || '').toUpperCase() : '';
    if (subscriptionTypes.has(productType)) subscriptionUnits += rowUnits;
    if (!currency && rowCurrency) currency = rowCurrency;
  }

  return { proceeds, units, subscriptionUnits, currency: currency || targetCurrency, matchedRows };
}

function aggregateSubscriptionReport(table, appContext) {
  if (!table || !table.rows.length) return { activeSubscriptions: 0, matchedRows: 0 };

  const activeIdx = columnIndex(table.headers, [
    'Active Standard Price Subscriptions',
    'Active Subscriptions',
    'Active Paid Subscriptions',
    'Active Paying Subscriptions',
  ]);
  const trialIdx = columnIndex(table.headers, [
    'Active Free Trial Subscriptions',
    'Active Introductory Offer Subscriptions',
  ]);

  let activeSubscriptions = 0;
  let matchedRows = 0;

  for (const row of table.rows) {
    if (!rowMatchesApp(row, table.headers, appContext)) continue;

    matchedRows += 1;
    if (activeIdx >= 0) activeSubscriptions += parseNumber(row[activeIdx]);
    if (trialIdx >= 0) activeSubscriptions += parseNumber(row[trialIdx]);
  }

  return { activeSubscriptions, matchedRows };
}

async function fetchDailySales(env, vendorNumber, reportDate, appContext) {
  try {
    const table = await loadReport(env, {
      vendorNumber,
      reportType: 'SALES',
      reportSubType: 'SUMMARY',
      frequency: 'DAILY',
      reportDate,
      version: '1_0',
    });
    if (!table) return { reportDate, stats: null, status: 'missing' };
    return {
      reportDate,
      stats: aggregateSalesReport(table, appContext),
      status: 'ok',
    };
  } catch (err) {
    return { reportDate, stats: null, status: 'error', error: err.message || 'Sales report failed' };
  }
}

async function fetchMonthlySales(env, vendorNumber, reportDate, appContext) {
  try {
    const table = await loadReport(env, {
      vendorNumber,
      reportType: 'SALES',
      reportSubType: 'SUMMARY',
      frequency: 'MONTHLY',
      reportDate,
      version: '1_0',
    });
    if (!table) return { reportDate, stats: null, status: 'missing' };
    return {
      reportDate,
      stats: aggregateSalesReport(table, appContext),
      status: 'ok',
    };
  } catch (err) {
    return { reportDate, stats: null, status: 'error', error: err.message || 'Monthly sales report failed' };
  }
}

export async function fetchAppStoreFinancial(env, appleAppId, appContext = {}) {
  const vendorNumber = env.APPLE_VENDOR_NUMBER;
  if (!vendorNumber) {
    return {
      configured: false,
      error:
        'Set APPLE_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports → Vendor ID)',
    };
  }

  const context = {
    appleAppId,
    appName: appContext.appName || '',
    bundleId: appContext.bundleId || env.APPLE_BUNDLE_ID || '',
    appSku: appContext.appSku || '',
    currency: 'USD',
  };

  const dates = recentDates(30);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStartStr = formatDateUTC(monthStart);
  const currentMonth = formatMonthUTC(monthStart);

  const salesByDay = [];
  let last30Proceeds = 0;
  let monthProceeds = 0;
  let subscriptionOrders30d = 0;
  let currency = 'USD';
  let activeSubscriptions = 0;
  let reportsLoaded = 0;
  let reportsMissing = 0;
  let firstError = null;
  let totalMatchedRows = 0;

  const salesResults = await Promise.all(
    dates.map((reportDate) => fetchDailySales(env, vendorNumber, reportDate, context))
  );

  for (const entry of salesResults) {
    if (entry.status === 'missing') {
      reportsMissing += 1;
      continue;
    }
    if (entry.status === 'error') {
      if (!firstError) firstError = entry.error;
      continue;
    }

    reportsLoaded += 1;
    const { reportDate, stats } = entry;
    totalMatchedRows += stats.matchedRows;
    if (stats.currency) currency = stats.currency;
    last30Proceeds += stats.proceeds;
    subscriptionOrders30d += stats.subscriptionUnits;
    if (reportDate >= monthStartStr) monthProceeds += stats.proceeds;
    if (stats.proceeds > 0) {
      salesByDay.push({ date: reportDate, total: Math.round(stats.proceeds * 100) / 100 });
    }
  }

  if (reportsLoaded === 0 && !firstError) {
    try {
      const monthlyTable = await loadReport(env, {
        vendorNumber,
        reportType: 'SALES',
        reportSubType: 'SUMMARY',
        frequency: 'MONTHLY',
        reportDate: currentMonth,
        version: '1_0',
      });
      if (monthlyTable) {
        reportsLoaded += 1;
        const stats = aggregateSalesReport(monthlyTable, context);
        totalMatchedRows += stats.matchedRows;
        if (stats.currency) currency = stats.currency;
        if (stats.proceeds > 0) {
          monthProceeds = stats.proceeds;
          last30Proceeds = stats.proceeds;
          salesByDay.push({
            date: monthStartStr,
            total: Math.round(stats.proceeds * 100) / 100,
          });
        }
        subscriptionOrders30d += stats.subscriptionUnits;
      }
    } catch (err) {
      if (!firstError) firstError = err.message || 'Monthly sales report failed';
    }
  }

  for (const reportDate of dates.slice(0, 14)) {
    try {
      const table = await loadReport(env, {
        vendorNumber,
        reportType: 'SUBSCRIPTION',
        reportSubType: 'SUMMARY',
        frequency: 'DAILY',
        reportDate,
        version: '1_3',
      });
      if (!table) continue;
      const stats = aggregateSubscriptionReport(table, context);
      if (stats.activeSubscriptions > 0) {
        activeSubscriptions = stats.activeSubscriptions;
        break;
      }
    } catch (err) {
      if (!firstError) firstError = err.message || 'Subscription report failed';
    }
  }

  salesByDay.sort((a, b) => a.date.localeCompare(b.date));

  const result = {
    configured: true,
    currency,
    last30Days: Math.round(last30Proceeds * 100) / 100,
    monthToDate: Math.round(monthProceeds * 100) / 100,
    subscriptionOrders30d,
    activeSubscriptions,
    revenueByDay: salesByDay,
    revenueByMonth: monthProceeds > 0 ? [{
      month: currentMonth,
      total: Math.round(monthProceeds * 100) / 100,
    }] : [],
    allTime: Math.round(monthProceeds * 100) / 100,
    source: 'sales_reports',
    note: 'USD developer proceeds from App Store Connect sales reports (next-day data).',
  };

  if (firstError) {
    result.warning =
      'Some App Store reports failed. Ensure the API key has Finance access. ' + firstError;
  } else if (reportsLoaded === 0) {
    result.warning =
      'No App Store sales reports returned for the last 30 days. Reports are usually available within 24–48 hours.';
  } else if (reportsLoaded > 0 && totalMatchedRows === 0) {
    result.warning =
      'Sales reports loaded but no rows matched this app (Apple ID ' +
      appleAppId +
      '). Check APPLE_VENDOR_NUMBER and bundle ID.';
  }

  return result;
}

export async function fetchAppStoreMonthlyRevenue(env, appleAppId, appContext = {}, months = 36) {
  const vendorNumber = env.APPLE_VENDOR_NUMBER;
  if (!vendorNumber) {
    return {
      configured: false,
      error:
        'Set APPLE_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports → Vendor ID)',
    };
  }

  const context = {
    appleAppId,
    appName: appContext.appName || '',
    bundleId: appContext.bundleId || env.APPLE_BUNDLE_ID || '',
    appSku: appContext.appSku || '',
    currency: 'USD',
  };

  const monthlyResults = await Promise.all(
    recentClosedMonths(months).map((reportDate) => fetchMonthlySales(env, vendorNumber, reportDate, context))
  );

  let currency = 'USD';
  let firstError = null;
  const revenueByMonth = [];

  for (const entry of monthlyResults) {
    if (entry.status === 'error') {
      if (!firstError) firstError = entry.error;
      continue;
    }
    if (entry.status !== 'ok' || !entry.stats || entry.stats.proceeds <= 0) continue;

    if (entry.stats.currency) currency = entry.stats.currency;
    revenueByMonth.push({
      month: entry.reportDate,
      total: Math.round(entry.stats.proceeds * 100) / 100,
    });
  }

  revenueByMonth.sort((a, b) => a.month.localeCompare(b.month));

  const result = {
    configured: true,
    currency,
    revenueByMonth,
    allTime: Math.round(revenueByMonth.reduce((sum, item) => sum + item.total, 0) * 100) / 100,
    source: 'sales_reports',
    note: 'USD developer proceeds from App Store Connect monthly sales reports.',
  };

  if (firstError) {
    result.warning = 'Some App Store monthly reports failed. ' + firstError;
  }

  return result;
}
