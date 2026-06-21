import { handleAuth, requireAuth, corsHeaders } from './auth.js';
import { fetchPlayMetrics } from './google-play.js';
import { fetchAppStoreMetrics } from './app-store.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const headers = {
      'Content-Type': 'application/json',
      ...cors,
    };

    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: cors });
    }

    const authResponse = await handleAuth(request, env, pathname);
    if (authResponse) return authResponse;

    if (pathname === '/api/metrics' && request.method === 'GET') {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers,
        });
      }

      const warnings = [];
      let android = { reviewCount: 0, averageRating: null, starDistribution: [0, 0, 0, 0, 0] };
      let ios = { reviewCount: 0, averageRating: null, starDistribution: [0, 0, 0, 0, 0] };
      let playConfigured = false;
      let appStoreConfigured = false;

      try {
        const play = await fetchPlayMetrics(env);
        playConfigured = !!play.configured;
        if (play.configured) {
          android = play;
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
