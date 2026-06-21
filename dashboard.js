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

  let charts = {};

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

  function formatCount(value) {
    if (value == null) return '—';
    return Number(value).toLocaleString('en-US');
  }

  function destroyCharts() {
    Object.values(charts).forEach((chart) => chart.destroy());
    charts = {};
  }

  function makeBarChart(canvasId, labels, data, label) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label,
          data,
          backgroundColor: chartColors.bars,
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

  function makeComparisonChart(androidRating, iosRating) {
    const canvas = document.getElementById('chart-comparison');
    if (!canvas) return;

    charts.comparison = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['Average rating'],
        datasets: [
          {
            label: 'Android',
            data: [androidRating ?? 0],
            backgroundColor: chartColors.android,
            borderRadius: 6,
          },
          {
            label: 'iOS',
            data: [iosRating ?? 0],
            backgroundColor: chartColors.ios,
            borderRadius: 6,
          },
        ],
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
            min: 0,
            max: 5,
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
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      return value.toLocaleString('en-US') + (currency ? ' ' + currency : '');
    }
  }

  function makeRevenueChart(androidRev, iosRev) {
    const canvas = document.getElementById('chart-revenue');
    if (!canvas) return;

    const androidDays = (androidRev && androidRev.revenueByDay) || [];
    const iosDays = (iosRev && iosRev.revenueByDay) || [];
    const labels = [...new Set([...androidDays, ...iosDays].map((d) => d.date))].sort();
    const androidMap = Object.fromEntries(androidDays.map((d) => [d.date, d.total]));
    const iosMap = Object.fromEntries(iosDays.map((d) => [d.date, d.total]));

    charts.revenue = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels.map((d) => d.slice(5)),
        datasets: [
          {
            label: 'Android',
            data: labels.map((d) => androidMap[d] || 0),
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74, 222, 128, 0.12)',
            fill: false,
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: 'iOS',
            data: labels.map((d) => iosMap[d] || 0),
            borderColor: '#60a5fa',
            backgroundColor: 'rgba(96, 165, 250, 0.12)',
            fill: false,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
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
            ticks: { color: chartColors.text, maxTicksLimit: 10 },
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
      ios && ios.currency ? ios.currency + ' · developer proceeds' : 'Needs APPLE_VENDOR_NUMBER'
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
      ios && ios.note ? ios.note : 'Developer proceeds · App Store reports'
    );

    makeRevenueChart(android, ios);
  }

  function renderMetrics(data) {
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

    destroyCharts();

    const starLabels = ['1★', '2★', '3★', '4★', '5★'];
    makeBarChart(
      'chart-android-stars',
      starLabels,
      android.starDistribution || [0, 0, 0, 0, 0],
      'Reviews'
    );
    makeBarChart(
      'chart-ios-stars',
      starLabels,
      ios.starDistribution || [0, 0, 0, 0, 0],
      'Reviews'
    );
    makeComparisonChart(android.averageRating, ios.averageRating);

    renderRevenue(data.revenue, (data.ios && data.ios.financial) || null);
    renderWarnings(data.warnings);
  }

  async function loadMetrics() {
    refreshBtn.disabled = true;
    try {
      const data = await api('/metrics');
      renderMetrics(data);
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
    try {
      await api('/auth/session');
      showDashboard();
      await loadMetrics();
    } catch {
      showLogin();
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
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

  checkSession();
})();
