import { handleAuth, requireAuth, corsHeaders } from './auth.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(request);
    const headers = {
      'Content-Type': 'application/json',
      ...cors,
    };

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: cors });
    }

    const authResponse = await handleAuth(request, env, pathname);
    if (authResponse) return authResponse;

    if (pathname === '/api/ios-revenue-month' && request.method === 'GET') {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers,
        });
      }

      const month = url.searchParams.get('month') || '';
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return new Response(JSON.stringify({ error: 'Invalid month. Use YYYY-MM.' }), {
          status: 400,
          headers,
        });
      }

      try {
        const { fetchAppStoreMonthDailyRevenue } = await import('./app-store.js');
        const monthData = await fetchAppStoreMonthDailyRevenue(env, month);
        return new Response(JSON.stringify(monthData), { status: 200, headers });
      } catch (err) {
        return new Response(
          JSON.stringify({ configured: false, error: err.message || 'Monthly daily revenue failed' }),
          { status: 500, headers }
        );
      }
    }

    if (pathname === '/api/ios-revenue-history' && request.method === 'GET') {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers,
        });
      }

      try {
        const { fetchAppStoreRevenueHistory } = await import('./app-store.js');
        const history = await fetchAppStoreRevenueHistory(env);
        return new Response(JSON.stringify(history), { status: 200, headers });
      } catch (err) {
        return new Response(
          JSON.stringify({ configured: false, error: err.message || 'Revenue history failed' }),
          { status: 500, headers }
        );
      }
    }

    if (pathname === '/api/metrics' && request.method === 'GET') {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers,
        });
      }

      const { fetchPlayMetrics } = await import('./google-play.js');
      const { fetchPlayRevenue } = await import('./google-play-revenue.js');
      const { fetchPlayRetention } = await import('./google-play-retention.js');
      const { fetchAppStoreMetrics } = await import('./app-store.js');

      const warnings = [];
      let android = { reviewCount: 0, averageRating: null, starDistribution: [0, 0, 0, 0, 0] };
      let ios = { reviewCount: 0, averageRating: null, starDistribution: [0, 0, 0, 0, 0] };
      let revenue = null;
      let playConfigured = false;
      let appStoreConfigured = false;

      try {
        const play = await fetchPlayMetrics(env);
        playConfigured = !!play.configured;
        if (play.configured) {
          android = play;
          try {
            let serviceAccount = null;
            if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
              serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
            }
            if (serviceAccount) {
              revenue = await fetchPlayRevenue(env, serviceAccount, play.packageName);
              if (revenue.error && !revenue.last30Days && revenue.last30Days !== 0) {
                warnings.push('Revenue: ' + revenue.error);
              }

              try {
                const retention = await fetchPlayRetention(env, serviceAccount, play.packageName);
                android = { ...android, retention };
                if (retention.error && retention.day1 == null) {
                  warnings.push('Android retention: ' + retention.error);
                }
              } catch (err) {
                warnings.push('Android retention: ' + (err.message || 'request failed'));
              }
            }
          } catch (err) {
            warnings.push('Revenue: ' + (err.message || 'request failed'));
          }
        } else if (play.error) {
          warnings.push('Google Play: ' + play.error);
        }
      } catch (err) {
        warnings.push('Google Play: ' + (err.message || 'request failed'));
      }

      try {
        const appStore = await fetchAppStoreMetrics(env);
        appStoreConfigured = !!appStore.configured;
        if (appStore.configured) {
          ios = appStore;
          if (appStore.financial?.error) {
            warnings.push('iOS revenue: ' + appStore.financial.error);
          } else if (appStore.financial?.warning) {
            warnings.push('iOS revenue: ' + appStore.financial.warning);
          }
          if (appStore.retention?.error && appStore.retention.day1 == null) {
            warnings.push('iOS retention: ' + appStore.retention.error);
          }
        } else if (appStore.error) {
          warnings.push('App Store: ' + appStore.error);
        }
      } catch (err) {
        warnings.push('App Store: ' + (err.message || 'request failed'));
      }

      if (!playConfigured && !appStoreConfigured) {
        warnings.push(
          'Deploy worker secrets to load live data. The dashboard login still works; charts stay empty until APIs are connected.'
        );
      }

      return new Response(
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          configured: { play: playConfigured, appStore: appStoreConfigured },
          android,
          ios,
          revenue,
          warnings,
        }),
        { status: 200, headers }
      );
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers,
    });
  },
};
