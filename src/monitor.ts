import { Env } from './types';
import { verifyBearer } from './auth';

const TARGET_URL = 'https://galsaril.com';
const EXPECTED_CONTENT = 'Gal Sar Israel';

export async function handleMonitor(req: Request, env: Env, route: string, origin: string): Promise<Response> {
  const payload = await verifyBearer(req, env);
  if (!payload) return resp({ error: 'Unauthorized' }, 401, origin);

  switch (route) {
    case 'status':  return resp(await status(env.DB), 200, origin);
    case 'deploys': return resp(await deploys(env.DB), 200, origin);
    default:        return resp({ error: 'Not found' }, 404, origin);
  }
}

export async function runMonitorCron(env: Env): Promise<void> {
  const start = Date.now();
  let statusCode = 0;
  let ok = false;

  try {
    const res = await fetch(TARGET_URL, { signal: AbortSignal.timeout(15_000) });
    statusCode = res.status;
    if (res.ok) {
      const body = await res.text();
      ok = body.includes(EXPECTED_CONTENT);
    }
  } catch {
    ok = false;
  }

  const latency = Date.now() - start;
  await env.DB.prepare(
    'INSERT INTO monitor_log (ts, status_code, latency_ms, ok, triggered_by) VALUES (?,?,?,?,?)'
  ).bind(Date.now(), statusCode, latency, ok ? 1 : 0, 'cron').run();
}

async function status(db: D1Database) {
  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

  const [recentRows, statsRow, lastRow] = await Promise.all([
    db.prepare('SELECT ts, status_code, latency_ms, ok, triggered_by FROM monitor_log ORDER BY ts DESC LIMIT 50').all<MonitorRow>(),
    db.prepare('SELECT COUNT(*) as total, SUM(ok) as up FROM monitor_log WHERE ts >= ?').bind(thirtyDaysAgo).first<{ total: number; up: number }>(),
    db.prepare('SELECT ts, status_code, latency_ms, ok FROM monitor_log ORDER BY ts DESC LIMIT 1').first<MonitorRow>(),
  ]);

  const checks = recentRows.results;
  const p95 = percentile(checks.map(c => c.latency_ms).filter(Boolean), 95);
  const uptime30d = statsRow && statsRow.total > 0
    ? Math.round(statsRow.up / statsRow.total * 1000) / 10
    : 100;

  return { uptime30d, lastCheck: lastRow, recentChecks: checks, p95Latency: p95 };
}

async function deploys(db: D1Database) {
  const rows = await db.prepare(
    "SELECT ts, status_code, latency_ms, ok, triggered_by FROM monitor_log WHERE triggered_by = 'deploy' ORDER BY ts DESC LIMIT 20"
  ).all<MonitorRow>();
  return { deploys: rows.results };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

interface MonitorRow {
  ts: number;
  status_code: number;
  latency_ms: number;
  ok: number;
  triggered_by: string;
}

function resp(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' },
  });
}
