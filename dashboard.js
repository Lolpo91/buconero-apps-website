(function () {
  'use strict';

  const API_BASE = 'https://buconero-dashboard-api.buconero.workers.dev/api';
  const SESSION_KEY = 'buconero_dashboard_token';

  const loginScreen = document.getElementById('login-screen');
  const dashboardScreen = document.getElementById('dashboard-screen');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const passwordInput = document.getElementById('password');
  const logoutBtn = document.getElementById('logout-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  const warningsEl = document.getElementById('api-warnings');
  const chartPanel = document.getElementById('dashboard-chart-panel');
  const chartTitle = document.getElementById('chart-title');
  const chartRange = document.getElementById('chart-range');
  const chartMonth = document.getElementById('chart-month');
  const chartMonthControl = document.getElementById('chart-month-control');
  const chartClose = document.getElementById('chart-close');
  const chartEmpty = document.getElementById('chart-empty');

  let charts = {};
  let activeChart = null;
  let metricsData = null;
  let iosRevenueHistoryLoading = false;
  let iosMonthDailyLoading = false;
  let chartSelectedMonth = '';
  let chartMonthsFingerprint = '';
  let authFlowId = 0;

  const chartColors = {
    grid: 'rgba(255, 255, 255, 0.06)',
    text: '#8a8a94',
    bars: ['#f87171', '#fb923c', '#facc15', '#4ade80', '#60a5fa'],
    android: '#4ade80',
    ios: '#60a5fa',
  };

  function showLogin() {
    loginScreen.hidden = false;
    loginScreen.classList.remove('hidden');
    dashboardScreen.hidden = true;
    dashboardScreen.classList.add('hidden');
    passwordInput.value = '';
    loginError.hidden = true;
  }

  function showDashboard() {
    loginScreen.hidden = true;
    loginScreen.classList.add('hidden');
    dashboardScreen.hidden = false;
    dashboardScreen.classList.remove('hidden');
  }

  function authHeaders(extra) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    const token = sessionStorage.getItem(SESSION_KEY);
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  async function api(path, options) {
    const res = await fetch(API_BASE + path, {
      ...options,
      credentials: 'include',
      headers: authHeaders(options && options.headers),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message = data.error || 'Request failed';
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }

    return data;
  }

  function formatRating(value) {
    if (value == null || Number.isNaN(value)) return '—';
    return value.toFixed(1) + '★';
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return '—';
    return value.toFixed(1) + '%';
  }

  function formatCount(value) {
    if (value == null) return '—';
    return Number(value).toLocaleString('en-US');
  }

  function formatRetentionSub(parts) {
    return parts
      .map((part) => part.label + ' ' + formatPercent(part.value))
      .join(' · ');
  }

  function destroyCharts() {
    Object.values(charts).forEach((chart) => chart.destroy());
    charts = {};
  }

  function chartCanvas() {
    return document.getElementById('chart-detail');
  }

  function hasChartData(data) {
    return Array.isArray(data) && data.some((value) => value != null && Number(value) >= 0);
  }

  function setChartEmpty(isEmpty) {
    if (!chartEmpty) return;
    chartEmpty.hidden = !isEmpty;
    const wrap = chartCanvas()?.closest('.dashboard-chart-wrap');
    if (wrap) wrap.hidden = isEmpty;
  }

  function makeDetailBarChart(labels, data, label, color) {
    const canvas = chartCanvas();
    if (!canvas) return;

    destroyCharts();
    setChartEmpty(!hasChartData(data));
    if (!hasChartData(data)) return;

    charts.detail = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label,
          data,
          backgroundColor: Array.isArray(color) ? color : color || chartColors.ios,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: {
            grid: { color: chartColors.grid },
            ticks: { color: chartColors.text },
          },
          y: {
            beginAtZero: true,
            grid: { color: chartColors.grid },
            ticks: {
              color: chartColors.text,
              precision: 0,
            },
          },
        },
      },
    });
  }

  function makeDetailLineChart(labels, datasets) {
    const canvas = chartCanvas();
    if (!canvas) return;

    destroyCharts();
    const hasData = datasets.some((dataset) => hasChartData(dataset.data));
    setChartEmpty(!hasData);
    if (!hasData) return;

    charts.detail = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: chartColors.text },
          },
        },
        scales: {
          x: {
            grid: { color: chartColors.grid },
            ticks: { color: chartColors.text },
          },
          y: {
            beginAtZero: true,
            grid: { color: chartColors.grid },
            ticks: { color: chartColors.text },
          },
        },
      },
    });
  }

  function renderWarnings(warnings) {
    if (!warnings || !warnings.length) {
      warningsEl.hidden = true;
      warningsEl.innerHTML = '';
      return;
    }

    warningsEl.hidden = false;
    warningsEl.innerHTML =
      '<strong>API setup notes</strong><ul>' +
      warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') +
      '</ul>';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMoney(value, currency) {
    if (value == null || Number.isNaN(value)) return '—';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return value.toLocaleString('en-US') + (currency ? ' ' + currency : '');
    }
  }

  function monthLabel(month) {
    const [year, monthNumber] = String(month || '').split('-').map(Number);
    if (!year || !monthNumber) return month || '';
    return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  }

  function getMetricSources() {
    const android = metricsData?.android || {};
    const ios = metricsData && metricsData.ios ? metricsData.ios : {};
    const androidRevenue = metricsData && metricsData.revenue && metricsData.revenue.configured !== false
      ? metricsData.revenue
      : null;
    const iosRevenue = ios.financial && ios.financial.configured !== false ? ios.financial : null;
    const androidRetention = android.retention && android.retention.configured !== false ? android.retention : null;
    const iosRetention = ios.retention && ios.retention.configured !== false ? ios.retention : null;
    return { android, ios, androidRevenue, iosRevenue, androidRetention, iosRetention };
  }

  function isValidMonth(value) {
    return /^\d{4}-\d{2}$/.test(String(value || '').trim());
  }

  function currentMonthKey() {
    const now = new Date();
    return now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
  }

  function monthsForRevenue(revenue) {
    const monthSet = new Set();
    (revenue?.revenueByMonth || []).forEach((item) => monthSet.add(item.month));
    (revenue?.revenueByDay || []).forEach((item) => monthSet.add(item.date.slice(0, 7)));
    return [...monthSet].sort().reverse();
  }

  function mergeMonthSeries(primary, secondary) {
    const byMonth = new Map();
    [...(secondary || []), ...(primary || [])].forEach((item) => {
      if (item && item.month) byMonth.set(item.month, item);
    });
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  async function ensureIosRevenueHistory() {
    const iosFinancial = metricsData?.ios?.financial;
    if (!iosFinancial || iosFinancial.historyLoaded || iosRevenueHistoryLoading) return;

    iosRevenueHistoryLoading = true;
    try {
      const history = await api('/ios-revenue-history');
      if (history && history.configured !== false) {
        iosFinancial.revenueByMonth = mergeMonthSeries(
          history.revenueByMonth || [],
          iosFinancial.revenueByMonth || []
        );
        iosFinancial.allTime = iosFinancial.revenueByMonth.reduce((sum, item) => sum + Number(item.total || 0), 0);
        iosFinancial.currency = history.currency || iosFinancial.currency || 'USD';
        iosFinancial.historyLoaded = true;
      } else if (history?.error) {
        renderWarnings([...(metricsData.warnings || []), 'iOS revenue history: ' + history.error]);
      }
    } catch (err) {
      renderWarnings([...(metricsData.warnings || []), 'iOS revenue history: ' + (err.message || 'request failed')]);
    } finally {
      iosRevenueHistoryLoading = false;
    }
  }

  async function ensureIosMonthDaily(month) {
    const iosFinancial = metricsData?.ios?.financial;
    if (!iosFinancial || !isValidMonth(month)) return;

    iosFinancial.revenueByDayByMonth = iosFinancial.revenueByDayByMonth || {};
    if (iosFinancial.revenueByDayByMonth[month] || iosMonthDailyLoading) return;

    iosMonthDailyLoading = true;
    try {
      const monthData = await api('/ios-revenue-month?month=' + encodeURIComponent(month));
      if (monthData && monthData.configured !== false) {
        iosFinancial.revenueByDayByMonth[month] = monthData.revenueByDay || [];
      } else if (monthData?.error) {
        renderWarnings([...(metricsData.warnings || []), 'iOS month revenue: ' + monthData.error]);
      }
    } catch (err) {
      renderWarnings([...(metricsData.warnings || []), 'iOS month revenue: ' + (err.message || 'request failed')]);
    } finally {
      iosMonthDailyLoading = false;
    }
  }

  function dailyForMonth(revenue, month) {
    if (!isValidMonth(month)) return [];

    const cached = revenue?.revenueByDayByMonth?.[month];
    if (Array.isArray(cached)) return cached;

    return (revenue?.revenueByDay || []).filter((item) => item.date.slice(0, 7) === month);
  }

  function configureChartControls(type) {
    const isRevenue = type === 'ios-revenue' || type === 'android-revenue';
    chartRange.parentElement.hidden = !isRevenue;
    chartMonthControl.hidden = !isRevenue || chartRange.value !== 'month';

    if (!isRevenue) return;

    const { androidRevenue, iosRevenue } = getMetricSources();
    const revenue = type === 'ios-revenue' ? iosRevenue : androidRevenue;
    const months = monthsForRevenue(revenue);
    const fingerprint = months.join('|');

    if (fingerprint !== chartMonthsFingerprint) {
      chartMonthsFingerprint = fingerprint;
      chartMonth.innerHTML = months
        .map((month) => '<option value="' + month + '">' + monthLabel(month) + '</option>')
        .join('');

      if (!months.length) {
        chartMonth.innerHTML = '<option value="">No months</option>';
        chartSelectedMonth = '';
      }
    }

    if (months.length) {
      if (!isValidMonth(chartSelectedMonth) || !months.includes(chartSelectedMonth)) {
        chartSelectedMonth = months[0];
      }
      chartMonth.value = chartSelectedMonth;
    }
  }

  function renderRetentionChart(title, retention, keys, colors) {
    chartTitle.textContent = title;
    const series = retention?.retentionByDay || [];
    if (!series.length) {
      setChartEmpty(true);
      return;
    }

    const labels = series.map((item) => (item.date ? item.date.slice(5) : ''));
    const datasets = keys
      .map((key, index) => {
        const data = series.map((item) => item[key.key]);
        if (!hasChartData(data)) return null;
        return revenueDataset(key.label, data, colors[index] || chartColors.ios);
      })
      .filter(Boolean);

    if (!datasets.length) {
      setChartEmpty(true);
      return;
    }

    makeDetailLineChart(labels, datasets);
  }

  function revenueDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: color.replace(')', ', 0.12)').replace('rgb', 'rgba'),
      fill: false,
      tension: 0.3,
      pointRadius: 2,
    };
  }

  function renderRevenueChart(title, revenue, color) {
    chartTitle.textContent = title;

    if (chartRange.value === 'month') {
      const selectedMonth = chartSelectedMonth;
      if (!isValidMonth(selectedMonth)) {
        setChartEmpty(true);
        return;
      }

      const daily = dailyForMonth(revenue, selectedMonth);
      if (daily.length) {
        makeDetailLineChart(
          daily.map((item) => item.date.slice(5)),
          [revenueDataset(title, daily.map((item) => item.total), color)]
        );
        return;
      }

      const monthlyTotal = (revenue?.revenueByMonth || []).find((item) => item.month === selectedMonth);
      makeDetailBarChart(
        [monthLabel(selectedMonth)],
        [monthlyTotal ? monthlyTotal.total : 0],
        title,
        color
      );
      return;
    }

    const monthly = revenue?.revenueByMonth || [];
    makeDetailLineChart(
      monthly.map((item) => monthLabel(item.month)),
      [revenueDataset(title, monthly.map((item) => item.total), color)]
    );
  }

  async function renderActiveChart() {
    if (!activeChart || !metricsData) return;

    const { android, ios, androidRevenue, iosRevenue, androidRetention, iosRetention } = getMetricSources();
    document.querySelectorAll('.dashboard-chart-trigger').forEach((card) => {
      card.classList.toggle('is-active', card.dataset.chart === activeChart);
    });

    if (activeChart === 'ios-revenue') {
      if (chartRange.value === 'month' && isValidMonth(chartSelectedMonth)) {
        await ensureIosMonthDaily(chartSelectedMonth);
      }
      renderRevenueChart('iOS revenue', iosRevenue, chartColors.ios);
      return;
    }

    if (activeChart === 'android-revenue') {
      renderRevenueChart('Android revenue', androidRevenue, chartColors.android);
      return;
    }

    chartRange.parentElement.hidden = true;
    chartMonthControl.hidden = true;

    if (activeChart === 'ios-subscriptions') {
      chartTitle.textContent = 'iOS subscriptions';
      makeDetailBarChart(
        ['Active', 'Purchases (30d)'],
        [iosRevenue?.activeSubscriptions || 0, iosRevenue?.subscriptionOrders30d || 0],
        'Subscriptions',
        [chartColors.ios, '#a78bfa']
      );
      return;
    }

    if (activeChart === 'android-subscriptions') {
      chartTitle.textContent = 'Android subscription orders';
      makeDetailBarChart(
        ['Orders (30d)'],
        [androidRevenue?.subscriptionOrders30d || 0],
        'Orders',
        chartColors.android
      );
      return;
    }

    if (activeChart === 'ios-rating' || activeChart === 'android-rating') {
      const isIos = activeChart === 'ios-rating';
      chartTitle.textContent = isIos ? 'iOS star distribution' : 'Android star distribution';
      makeDetailBarChart(
        ['1★', '2★', '3★', '4★', '5★'],
        isIos ? ios.starDistribution || [0, 0, 0, 0, 0] : android.starDistribution || [0, 0, 0, 0, 0],
        'Reviews',
        chartColors.bars
      );
      return;
    }

    if (activeChart === 'android-crashes') {
      chartTitle.textContent = 'Android crashes (7d)';
      makeDetailBarChart(
        ['Crash rate'],
        [android.crashRate7d || 0],
        'Crash rate %',
        '#f87171'
      );
      return;
    }

    if (activeChart === 'android-retention') {
      renderRetentionChart(
        'Android retention',
        androidRetention,
        [
          { key: 'day1', label: 'Day 1' },
          { key: 'day7', label: 'Day 7' },
          { key: 'day30', label: 'Day 30' },
        ],
        [chartColors.android, '#34d399', '#a7f3d0']
      );
      return;
    }

    if (activeChart === 'ios-retention') {
      renderRetentionChart(
        'iOS retention',
        iosRetention,
        [
          { key: 'day1', label: 'Day 1' },
          { key: 'day7', label: 'Day 7' },
          { key: 'day28', label: 'Day 28' },
        ],
        [chartColors.ios, '#818cf8', '#c4b5fd']
      );
    }
  }

  async function openChart(type, options) {
    const opts = options || {};
    activeChart = type;
    chartPanel.hidden = false;
    chartRange.value = opts.range || 'all';
    chartSelectedMonth = opts.month || currentMonthKey();

    if (type === 'ios-revenue') {
      await ensureIosRevenueHistory();
    }

    configureChartControls(type);
    await renderActiveChart();
    chartPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeChart() {
    activeChart = null;
    chartSelectedMonth = '';
    chartMonthsFingerprint = '';
    chartPanel.hidden = true;
    destroyCharts();
    document.querySelectorAll('.dashboard-chart-trigger').forEach((card) => {
      card.classList.remove('is-active');
    });
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function renderRevenue(androidRevenue, iosFinancial) {
    const android = androidRevenue && androidRevenue.configured !== false ? androidRevenue : null;
    const ios = iosFinancial && iosFinancial.configured !== false ? iosFinancial : null;

    setText(
      'stat-android-revenue-30d',
      android && android.last30Days != null ? formatMoney(android.last30Days, android.currency) : '—'
    );
    setText(
      'stat-android-revenue-month',
      android && android.monthToDate != null ? formatMoney(android.monthToDate, android.currency) : '—'
    );
    setText(
      'stat-android-revenue-currency',
      android && android.currency ? android.currency + ' · estimated sales' : 'Needs Play GCS bucket'
    );
    setText(
      'stat-android-subscription-orders',
      android && android.subscriptionOrders30d != null ? formatCount(android.subscriptionOrders30d) : '—'
    );
    setText(
      'stat-android-revenue-note',
      android && android.note ? android.note : 'Estimated sales · before Google fees'
    );

    setText(
      'stat-ios-revenue-30d',
      ios && ios.last30Days != null ? formatMoney(ios.last30Days, ios.currency) : '—'
    );
    setText(
      'stat-ios-revenue-month',
      ios && ios.monthToDate != null ? formatMoney(ios.monthToDate, ios.currency) : '—'
    );
    setText(
      'stat-ios-revenue-currency',
      ios && ios.currency ? ios.currency + ' · customer revenue' : 'Needs APPLE_VENDOR_NUMBER'
    );
    setText(
      'stat-ios-active-subscriptions',
      ios && ios.activeSubscriptions != null ? formatCount(ios.activeSubscriptions) : '—'
    );
    setText(
      'stat-ios-subscription-orders',
      ios && ios.subscriptionOrders30d != null
        ? formatCount(ios.subscriptionOrders30d) + ' subscription purchases (30d)'
        : '— subscription purchases (30d)'
    );
    setText(
      'stat-ios-revenue-note',
      ios && ios.note ? ios.note : 'Before Apple fees/taxes · App Store reports'
    );
  }

  function renderRetention(android, ios) {
    const androidRetention = android?.retention && android.retention.configured !== false ? android.retention : null;
    const iosRetention = ios?.retention && ios.retention.configured !== false ? ios.retention : null;

    setText('stat-android-retention-d1', formatPercent(androidRetention?.day1));
    setText(
      'stat-android-retention-sub',
      androidRetention
        ? formatRetentionSub([
            { label: 'D7', value: androidRetention.day7 },
            { label: 'D30', value: androidRetention.day30 },
          ])
        : 'Installer retention · Play Console'
    );

    setText('stat-ios-retention-d1', formatPercent(iosRetention?.day1));
    setText(
      'stat-ios-retention-sub',
      iosRetention
        ? formatRetentionSub([
            { label: 'D7', value: iosRetention.day7 },
            { label: 'D28', value: iosRetention.day28 ?? iosRetention.day30 },
          ])
        : 'User retention · App Analytics'
    );
  }

  async function renderMetrics(data) {
    metricsData = data;
    const android = data.android || {};
    const ios = data.ios || {};

    document.getElementById('stat-android-rating').textContent = formatRating(android.averageRating);
    document.getElementById('stat-android-reviews').textContent =
      formatCount(android.reviewCount) + ' reviews';
    document.getElementById('stat-ios-rating').textContent = formatRating(ios.averageRating);
    document.getElementById('stat-ios-reviews').textContent =
      formatCount(ios.reviewCount) + ' reviews';
    document.getElementById('stat-android-crashes').textContent =
      android.crashRate7d != null ? android.crashRate7d.toFixed(2) + '%' : '—';

    const updated = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
    document.getElementById('stat-updated').textContent = updated.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const playOk = data.configured && data.configured.play;
    const appStoreOk = data.configured && data.configured.appStore;
    const parts = [];
    if (playOk) parts.push('Play Console');
    if (appStoreOk) parts.push('App Store Connect');
    document.getElementById('stat-api-status').textContent =
      parts.length ? parts.join(' + ') + ' connected' : 'API secrets not configured yet';

    renderRevenue(data.revenue, (data.ios && data.ios.financial) || null);
    renderRetention(android, ios);
    renderWarnings(data.warnings);
    if (activeChart) await renderActiveChart();
  }

  async function loadMetrics() {
    refreshBtn.disabled = true;
    try {
      const data = await api('/metrics');
      await renderMetrics(data);
    } catch (err) {
      if (err.status === 401) {
        showLogin();
        return;
      }
      renderWarnings([err.message || 'Failed to load metrics. Is the Cloudflare Worker deployed?']);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  async function checkSession() {
    const flowId = authFlowId;
    try {
      await api('/auth/session');
      if (flowId !== authFlowId) return;
      showDashboard();
      await loadMetrics();
    } catch {
      if (flowId !== authFlowId) return;
      showLogin();
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authFlowId += 1;
    loginError.hidden = true;

    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value }),
      });
      if (data.token) sessionStorage.setItem(SESSION_KEY, data.token);
      showDashboard();
      await loadMetrics();
    } catch (err) {
      loginError.textContent = err.message || 'Invalid password';
      loginError.hidden = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    sessionStorage.removeItem(SESSION_KEY);
    showLogin();
  });

  refreshBtn.addEventListener('click', loadMetrics);
  chartClose.addEventListener('click', closeChart);
  chartRange.addEventListener('change', async () => {
    configureChartControls(activeChart);
    if (activeChart === 'ios-revenue' && chartRange.value === 'all') {
      await ensureIosRevenueHistory();
      configureChartControls(activeChart);
    }
    await renderActiveChart();
  });
  chartMonth.addEventListener('change', async () => {
    chartSelectedMonth = chartMonth.value;
    await renderActiveChart();
  });

  document.querySelectorAll('.dashboard-chart-trigger').forEach((card) => {
    card.addEventListener('click', () =>
      openChart(card.dataset.chart, {
        range: card.dataset.chartRange || 'all',
        month: card.dataset.chartMonth || currentMonthKey(),
      })
    );
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openChart(card.dataset.chart, {
          range: card.dataset.chartRange || 'all',
          month: card.dataset.chartMonth || currentMonthKey(),
        });
      }
    });
  });

  checkSession();
})();
