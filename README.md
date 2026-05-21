# galsaril-api — Cloudflare Worker

Backend API at `api.galsaril.com`. Handles analytics tracking, admin authentication, uptime monitoring, and scheduled health checks.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Returns `ok` |
| POST | `/track` | none (rate-limited) | Ingest page views / events from portfolio |
| POST | `/auth/login` | none | Username + password → JWT + refresh cookie |
| POST | `/auth/refresh` | cookie | Exchange refresh cookie for new access token |
| DELETE | `/auth/refresh` | cookie | Logout — clears cookie + KV entry |
| POST | `/auth/settings/password` | JWT | Change password |
| GET | `/analytics/overview` | JWT | Today/yesterday stats, 30-day trend, active sessions |
| GET | `/analytics/geo` | JWT | Top countries, device/browser breakdown |
| GET | `/analytics/referrers` | JWT | Traffic sources |
| GET | `/analytics/engagement` | JWT | Section scroll depth, contact click rates |
| GET | `/monitor/status` | JWT | Uptime %, recent checks, p95 latency |

## Auth Design

- Password stored as `pbkdf2:600000:<saltHex>:<hashHex>` in KV under `credentials:<username>`
- Login rate limit: 5 attempts / 15 min per IP (KV counter)
- Access token: JWT HS256, 1-hour TTL
- Refresh token: random UUID, stored as SHA-256 hash in KV, 7-day TTL
- Refresh cookie: `__Secure-refresh`, httpOnly, SameSite=Strict

## Data Stores

**D1 database** (`galsaril-db`):
- `page_views` — path, referrer, country, city, device, browser, session_id, ip_hash
- `events` — name, props (JSON), session_id, path
- `monitor_log` — status_code, latency_ms, ok, triggered_by

**KV namespace** (`AUTH_KV`):
- `credentials:<username>` → PBKDF2 hash string
- `refresh:<token_hash>` → `{ user, expires, ip }` JSON
- `rate:<ip>` → `{ count, window_start }` JSON
- `track_rate:<ip>` → request count (sliding 60s window)

## Cron

Runs every 15 minutes (`*/15 * * * *`): fetches `https://galsaril.com`, checks for `"Gal Sar Israel"` in body, writes result to `monitor_log`.

## Dev

```bash
npm install
npm run dev          # wrangler dev (localhost:8787)
npm run setup-password   # interactive: outputs wrangler kv key put command
```

Requires `wrangler.toml` with real D1 database ID and KV namespace ID. See SETUP.md.

## Deploy

```bash
npx wrangler deploy
```

Or via Jenkins `worker-deploy` job.
