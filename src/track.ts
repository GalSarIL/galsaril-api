import { Env } from './types';

const ALLOWED_EVENTS = new Set(['page_view', 'section_view', 'contact_click']);
const MAX_PATH_LEN   = 200;
const MAX_REF_LEN    = 500;
const RATE_KEY_TTL   = 65;

export async function handleTrack(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin') || '';
  const corsOrigin = origin === env.ALLOWED_SITE_ORIGIN ? origin : '';

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `track-rl:${ip}`;
  const count = parseInt(await env.AUTH_KV.get(rlKey) || '0');
  if (count >= 100) {
    return new Response(null, { status: 429, headers: { 'Access-Control-Allow-Origin': corsOrigin } });
  }
  await env.AUTH_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_KEY_TTL });

  let body: { name?: string; props?: Record<string, string>; path?: string; referrer?: string; ts?: number; session_id?: string };
  try { body = await req.json(); } catch {
    return new Response(null, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin } });
  }

  const name = body.name || '';
  if (!ALLOWED_EVENTS.has(name)) {
    return new Response(null, { status: 400, headers: { 'Access-Control-Allow-Origin': corsOrigin } });
  }

  const path       = (body.path || '/').slice(0, MAX_PATH_LEN);
  const referrer   = (body.referrer || '').slice(0, MAX_REF_LEN) || null;
  const sessionId  = (body.session_id || '').slice(0, 64);
  const ts         = Date.now();
  const cf         = (req as Request & { cf?: { country?: string; city?: string } }).cf;
  const country    = cf?.country || null;
  const city       = cf?.city || null;
  const ua         = req.headers.get('User-Agent') || '';
  const device     = detectDevice(ua);
  const browser    = detectBrowser(ua);
  const ipHash     = await sha256hex(ip);

  if (name === 'page_view') {
    await env.DB.prepare(
      'INSERT INTO page_views (ts, path, referrer, country, city, device, browser, session_id, ip_hash) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(ts, path, referrer, country, city, device, browser, sessionId, ipHash).run();
  } else {
    const props = body.props ? JSON.stringify(body.props) : null;
    await env.DB.prepare(
      'INSERT INTO events (ts, name, props, session_id, path) VALUES (?,?,?,?,?)'
    ).bind(ts, name, props, sessionId, path).run();
  }

  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': corsOrigin } });
}

function detectDevice(ua: string): string {
  if (/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/Mobile|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/.test(ua)) return 'mobile';
  return 'desktop';
}

function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua))    return 'Edge';
  if (/OPR\//.test(ua))    return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
