import { Env, JWTPayload, RateLimitEntry, RefreshTokenEntry } from './types';

const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const ACCESS_TTL        = 3600;
const REFRESH_TTL       = 7 * 24 * 3600;

export async function handleAuth(req: Request, env: Env, route: string, origin: string): Promise<Response> {
  const m = req.method;
  if (route === 'login'  && m === 'POST')   return login(req, env, origin);
  if (route === 'refresh' && m === 'POST')  return refresh(req, env, origin);
  if (route === 'logout'  && m === 'DELETE') return logout(req, env, origin);
  if (route === 'settings/password' && m === 'POST') return changePassword(req, env, origin);
  return resp({ error: 'Not found' }, 404, origin);
}

async function login(req: Request, env: Env, origin: string): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:${ip}`;
  const rlRaw = await env.AUTH_KV.get(rlKey);
  const rl: RateLimitEntry = rlRaw ? JSON.parse(rlRaw) : { count: 0, window_start: Date.now() };

  const inWindow = Date.now() - rl.window_start < RATE_LIMIT_WINDOW;
  if (inWindow && rl.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((rl.window_start + RATE_LIMIT_WINDOW - Date.now()) / 1000);
    return new Response(JSON.stringify({ error: 'Too many attempts' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter), 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' },
    });
  }

  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return resp({ error: 'Invalid body' }, 400, origin); }
  const { username, password } = body;
  if (!username || !password) return resp({ error: 'Missing fields' }, 400, origin);

  const stored = await env.AUTH_KV.get(`credentials:${username}`);
  const ok = stored ? await verifyPassword(password, stored) : (await dummyVerify(password), false);

  const newCount = inWindow ? rl.count + 1 : 1;
  const newWindow = inWindow ? rl.window_start : Date.now();
  await env.AUTH_KV.put(rlKey, JSON.stringify({ count: newCount, window_start: newWindow }), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000) + 60 });

  if (!stored || !ok) return resp({ error: 'Invalid credentials' }, 401, origin);

  await env.AUTH_KV.delete(rlKey);

  const accessToken = await signJWT({ sub: username, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) }, env.JWT_SECRET);
  const refreshToken = crypto.randomUUID();
  const refreshHash = await sha256hex(refreshToken);
  const entry: RefreshTokenEntry = { user: username, expires: Date.now() + REFRESH_TTL * 1000, ip };
  await env.AUTH_KV.put(`refresh:${refreshHash}`, JSON.stringify(entry), { expirationTtl: REFRESH_TTL });

  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Set-Cookie': `__Secure-refresh=${refreshToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_TTL}; Path=/auth`,
  });
  return new Response(JSON.stringify({ accessToken, username }), { status: 200, headers });
}

async function refresh(req: Request, env: Env, origin: string): Promise<Response> {
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/__Secure-refresh=([^;]+)/);
  if (!m) return resp({ error: 'No refresh token' }, 401, origin);

  const hash = await sha256hex(m[1]);
  const raw = await env.AUTH_KV.get(`refresh:${hash}`);
  if (!raw) return resp({ error: 'Invalid refresh token' }, 401, origin);

  const entry: RefreshTokenEntry = JSON.parse(raw);
  if (entry.expires < Date.now()) {
    await env.AUTH_KV.delete(`refresh:${hash}`);
    return resp({ error: 'Refresh token expired' }, 401, origin);
  }

  const accessToken = await signJWT(
    { sub: entry.user, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) },
    env.JWT_SECRET,
  );
  return resp({ accessToken, username: entry.user }, 200, origin);
}

async function logout(req: Request, env: Env, origin: string): Promise<Response> {
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/__Secure-refresh=([^;]+)/);
  if (m) {
    const hash = await sha256hex(m[1]);
    await env.AUTH_KV.delete(`refresh:${hash}`);
  }
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Set-Cookie': '__Secure-refresh=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/auth',
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function changePassword(req: Request, env: Env, origin: string): Promise<Response> {
  const payload = await verifyBearer(req, env);
  if (!payload) return resp({ error: 'Unauthorized' }, 401, origin);

  let body: { currentPassword?: string; newPassword?: string };
  try { body = await req.json(); } catch { return resp({ error: 'Invalid body' }, 400, origin); }
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword || newPassword.length < 12) {
    return resp({ error: 'New password must be at least 12 characters' }, 400, origin);
  }

  const stored = await env.AUTH_KV.get(`credentials:${payload.sub}`);
  if (!stored || !await verifyPassword(currentPassword, stored)) {
    return resp({ error: 'Invalid current password' }, 401, origin);
  }

  await env.AUTH_KV.put(`credentials:${payload.sub}`, await hashPassword(newPassword));
  return resp({ ok: true }, 200, origin);
}

// --- Crypto ---

export async function verifyBearer(req: Request, env: Env): Promise<JWTPayload | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map(n => n.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:600000:${hex(salt.buffer)}:${hex(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iters, saltHex, hashHex] = parts;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iters) }, key, 256);
  const computed = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computed.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

async function dummyVerify(password: string): Promise<void> {
  const dummy = 'pbkdf2:100000:' + '00'.repeat(32) + ':' + '00'.repeat(32);
  await verifyPassword(password, dummy);
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const msg = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${msg}.${sigB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const msg = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const pad = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const sigBytes = Uint8Array.from(atob(pad(parts[2])), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(msg));
  if (!valid) return null;
  const payload = JSON.parse(atob(pad(parts[1])));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload as JWTPayload;
}

function resp(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' },
  });
}
