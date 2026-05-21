import { Env } from './types';
import { handleAuth } from './auth';
import { handleTrack } from './track';
import { handleAnalytics } from './analytics';
import { handleMonitor, runMonitorCron } from './monitor';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const origin = resolveOrigin(request, env);

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      if (path === '/health')                    return new Response('ok', { status: 200 });
      if (path === '/track' && method === 'POST') return await handleTrack(request, env);
      if (path.startsWith('/auth/'))             return await handleAuth(request, env, path.slice(6), origin);
      if (path.startsWith('/analytics/'))        return await handleAnalytics(request, env, path.slice(11), origin);
      if (path.startsWith('/monitor/'))          return await handleMonitor(request, env, path.slice(9), origin);
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
      });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runMonitorCron(env);
  },
};

function resolveOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.ALLOWED_ADMIN_ORIGIN, env.ALLOWED_SITE_ORIGIN];
  return allowed.includes(origin) ? origin : '';
}
