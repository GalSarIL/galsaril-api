export interface Env {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  JWT_SECRET: string;
  ALLOWED_ADMIN_ORIGIN: string;
  ALLOWED_SITE_ORIGIN: string;
  CF_ANALYTICS_TOKEN: string;
  CF_ZONE_ID: string;
}

export interface JWTPayload {
  sub: string;
  exp: number;
  jti: string;
  iat: number;
}

export interface RateLimitEntry {
  count: number;
  window_start: number;
}

export interface RefreshTokenEntry {
  user: string;
  expires: number;
  ip: string;
}
