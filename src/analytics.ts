import { Env } from './types';
import { verifyBearer } from './auth';

export async function handleAnalytics(req: Request, env: Env, route: string, origin: string): Promise<Response> {
  const payload = await verifyBearer(req, env);
  if (!payload) return resp({ error: 'Unauthorized' }, 401, origin);

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get('days') || '30');
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  switch (route) {
    case 'overview':    return resp(await overview(env.DB, since, days), 200, origin);
    case 'geo':         return resp(await geo(env.DB, since), 200, origin);
    case 'referrers':   return resp(await referrers(env.DB, since), 200, origin);
    case 'engagement':  return resp(await engagement(env.DB, since), 200, origin);
    default:            return resp({ error: 'Not found' }, 404, origin);
  }
}

async function overview(db: D1Database, since: number, days: number) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();
  const yestTs = todayTs - 86_400_000;

  const [todayRow, yestRow, activeRow, dailyRows, totalRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) as pv, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE ts >= ?').bind(todayTs).first<{ pv: number; sessions: number }>(),
    db.prepare('SELECT COUNT(*) as pv, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE ts >= ? AND ts < ?').bind(yestTs, todayTs).first<{ pv: number; sessions: number }>(),
    db.prepare('SELECT COUNT(DISTINCT session_id) as count FROM page_views WHERE ts >= ?').bind(Date.now() - 5 * 60 * 1000).first<{ count: number }>(),
    db.prepare(`
      SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') as day,
             COUNT(*) as pv,
             COUNT(DISTINCT session_id) as sessions
      FROM page_views WHERE ts >= ?
      GROUP BY day ORDER BY day
    `).bind(since).all<{ day: string; pv: number; sessions: number }>(),
    db.prepare('SELECT COUNT(*) as total FROM page_views').first<{ total: number }>(),
  ]);

  return {
    today:     { pageViews: todayRow?.pv ?? 0, sessions: todayRow?.sessions ?? 0 },
    yesterday: { pageViews: yestRow?.pv ?? 0,  sessions: yestRow?.sessions ?? 0 },
    activeNow: activeRow?.count ?? 0,
    totalAllTime: totalRow?.total ?? 0,
    daily: dailyRows.results,
  };
}

async function geo(db: D1Database, since: number) {
  const [countriesRows, devicesRows, browsersRows] = await Promise.all([
    db.prepare(`
      SELECT country, COUNT(*) as count
      FROM page_views WHERE ts >= ? AND country IS NOT NULL
      GROUP BY country ORDER BY count DESC LIMIT 15
    `).bind(since).all<{ country: string; count: number }>(),
    db.prepare(`
      SELECT device, COUNT(*) as count
      FROM page_views WHERE ts >= ? AND device IS NOT NULL
      GROUP BY device ORDER BY count DESC
    `).bind(since).all<{ device: string; count: number }>(),
    db.prepare(`
      SELECT browser, COUNT(*) as count
      FROM page_views WHERE ts >= ? AND browser IS NOT NULL
      GROUP BY browser ORDER BY count DESC LIMIT 8
    `).bind(since).all<{ browser: string; count: number }>(),
  ]);

  const total = countriesRows.results.reduce((s, r) => s + r.count, 0) || 1;
  return {
    countries: countriesRows.results.map(r => ({ ...r, pct: Math.round(r.count / total * 1000) / 10 })),
    devices:   pct(devicesRows.results),
    browsers:  pct(browsersRows.results),
  };
}

async function referrers(db: D1Database, since: number) {
  const rows = await db.prepare(`
    SELECT referrer, COUNT(*) as count
    FROM page_views WHERE ts >= ?
    GROUP BY referrer ORDER BY count DESC LIMIT 50
  `).bind(since).all<{ referrer: string | null; count: number }>();

  const grouped: Record<string, number> = {};
  for (const { referrer, count } of rows.results) {
    const key = parseReferrer(referrer);
    grouped[key] = (grouped[key] || 0) + count;
  }

  const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, c]) => s + c, 0) || 1;
  return {
    sources: sorted.map(([source, count]) => ({ source, count, pct: Math.round(count / total * 1000) / 10 })),
  };
}

async function engagement(db: D1Database, since: number) {
  const [sectionsRows, contactRows, sessionRows] = await Promise.all([
    db.prepare(`
      SELECT json_extract(props, '$.section') as section, COUNT(*) as views
      FROM events WHERE name = 'section_view' AND ts >= ?
      GROUP BY section ORDER BY views DESC
    `).bind(since).all<{ section: string; views: number }>(),
    db.prepare(`
      SELECT json_extract(props, '$.target') as target, COUNT(*) as count
      FROM events WHERE name = 'contact_click' AND ts >= ?
      GROUP BY target ORDER BY count DESC
    `).bind(since).all<{ target: string; count: number }>(),
    db.prepare(`
      SELECT COUNT(DISTINCT session_id) as sessions, COUNT(*) as events
      FROM events WHERE ts >= ?
    `).bind(since).first<{ sessions: number; events: number }>(),
  ]);

  const contactClicks: Record<string, number> = {};
  for (const { target, count } of contactRows.results) {
    contactClicks[target] = count;
  }

  return {
    sections: sectionsRows.results,
    contactClicks,
    totalEventSessions: sessionRows?.sessions ?? 0,
  };
}

function parseReferrer(ref: string | null): string {
  if (!ref) return 'Direct';
  try {
    const u = new URL(ref);
    const h = u.hostname.replace(/^www\./, '');
    if (h.includes('google.'))     return 'google.com';
    if (h.includes('linkedin.'))   return 'linkedin.com';
    if (h.includes('github.'))     return 'github.com';
    if (h.includes('twitter.') || h.includes('t.co') || h.includes('x.com')) return 'twitter.com';
    return h;
  } catch { return 'Other'; }
}

function pct<T extends { count: number }>(rows: T[]): (T & { pct: number })[] {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return rows.map(r => ({ ...r, pct: Math.round(r.count / total * 1000) / 10 }));
}

function resp(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' },
  });
}
