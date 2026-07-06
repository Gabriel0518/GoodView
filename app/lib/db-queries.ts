import { q, withClient } from "./db";
import type { Snapshot, SnapDate, SnapChannel, SnapChannelDate, CampaignRow, Funnel, Stage } from "./data";

const IG_EVENT = process.env.BYTEPLUS_IG_AUTH_EVENT || "pwa_ins_login_button_click";
const CURRENCY = process.env.CURRENCY || "USD";
const APP_ID = Number(process.env.BYTEPLUS_APP_ID || 653834);
// 展示窗口：从 MAX(date) 往回取 N 天。库里可累积更多历史，这里控制看板显示范围。
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 180);
const SOURCES = ["fb", "tt", "bff", "AIguild", "AIguild_active", "AIguild_passive", "unknown"];

const addDays = (ymd: string, n: number) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isoOrNow = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date().toISOString());

// 率运算在 numeric 里做，最后 cast float8（复刻 JS rate(n,d)=d?n/d:0）。
// impression/click cast float8 → pg 返回 JS number（量级远小于 2^53，精确）。
const BYDATE_SQL = `
  SELECT to_char(c.date,'YYYY-MM-DD') AS date,
         c.cost::float8 AS cost, c.impression::float8 AS impression, c.click::float8 AS click,
         (COALESCE(c.cost / NULLIF(c.impression,0), 0) * 1000)::float8 AS cpm,
         COALESCE(c.click::numeric / NULLIF(c.impression,0), 0)::float8 AS ctr,
         COALESCE(c.cost / NULLIF(c.click,0), 0)::float8 AS cpc,
         COALESCE(i.count,0)::int AS ig_auth,
         COALESCE(c.cost / NULLIF(i.count,0), 0)::float8 AS cost_per_ig_auth
  FROM (
    SELECT date, SUM(cost) AS cost, SUM(impression) AS impression, SUM(click) AS click
    FROM campaign_daily WHERE date BETWEEN $1 AND $2 GROUP BY date
  ) c
  LEFT JOIN ig_auth_daily i ON i.date = c.date
  ORDER BY c.date`;

const BYCHANNEL_SQL = `
  SELECT channel,
         SUM(cost)::float8 AS cost, SUM(impression)::float8 AS impression, SUM(click)::float8 AS click,
         (COALESCE(SUM(cost)/NULLIF(SUM(impression),0),0)*1000)::float8 AS cpm,
         COALESCE(SUM(click)::numeric/NULLIF(SUM(impression),0),0)::float8 AS ctr,
         COALESCE(SUM(cost)/NULLIF(SUM(click),0),0)::float8 AS cpc
  FROM campaign_daily WHERE date BETWEEN $1 AND $2 GROUP BY channel ORDER BY SUM(cost) DESC`;

const BYCHANNELDATE_SQL = `
  SELECT to_char(date,'YYYY-MM-DD') AS date, channel,
         SUM(cost)::float8 AS cost, SUM(impression)::float8 AS impression, SUM(click)::float8 AS click,
         (COALESCE(SUM(cost)/NULLIF(SUM(impression),0),0)*1000)::float8 AS cpm,
         COALESCE(SUM(click)::numeric/NULLIF(SUM(impression),0),0)::float8 AS ctr,
         COALESCE(SUM(cost)/NULLIF(SUM(click),0),0)::float8 AS cpc
  FROM campaign_daily WHERE date BETWEEN $1 AND $2 GROUP BY date, channel ORDER BY date, channel`;

const CAMPAIGNROWS_SQL = `
  SELECT to_char(date,'YYYY-MM-DD') AS date, account_id, account_name, channel,
         campaign_id, campaign_name, cost::float8 AS cost,
         impression::float8 AS impression, click::float8 AS click
  FROM campaign_daily WHERE date BETWEEN $1 AND $2
  ORDER BY date DESC, account_id, campaign_id`;

export async function getSnapshot(): Promise<Snapshot | null> {
  return withClient(async (c) => {
    const w = await c.query<{ maxd: string | null; gen: Date | null }>(
      `SELECT to_char(MAX(date),'YYYY-MM-DD') AS maxd, MAX(updated_at) AS gen FROM campaign_daily`,
    );
    const maxd = w.rows[0]?.maxd;
    if (!maxd) return null; // 空库
    const start = addDays(maxd, -(WINDOW_DAYS - 1));
    const p = [start, maxd];

    // 顺序执行，复用同一条连接（避免并发连接被 proxy drop）
    const byDate = await c.query<SnapDate>(BYDATE_SQL, p);
    const byChannel = await c.query<SnapChannel>(BYCHANNEL_SQL, p);
    const byChannelDate = await c.query<SnapChannelDate>(BYCHANNELDATE_SQL, p);
    const igAuthByDate = await c.query<{ date: string; count: number }>(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, count::int AS count FROM ig_auth_daily WHERE date BETWEEN $1 AND $2 ORDER BY date`,
      p,
    );
    const campaignRows = await c.query<CampaignRow>(CAMPAIGNROWS_SQL, p);

    return {
      meta: {
        start_date: start,
        end_date: maxd,
        days: WINDOW_DAYS,
        currency: CURRENCY,
        generated_at: isoOrNow(w.rows[0]?.gen),
        ig_auth_event: IG_EVENT,
      },
      byDate: byDate.rows,
      byChannel: byChannel.rows,
      byChannelDate: byChannelDate.rows,
      igAuthByDate: igAuthByDate.rows,
      campaignRows: campaignRows.rows,
    };
  });
}

// 稠密网格：dates × sources LEFT JOIN funnel_daily，array_agg 得到对齐、0填充、长度=N 的 data[]。
const FUNNEL_SQL = `
  WITH dates AS (
    SELECT generate_series($1::date, $2::date, interval '1 day')::date AS date
  ),
  sources AS ( SELECT unnest($3::text[]) AS source ),
  grid AS (
    SELECT m.stage_key, m.ord, m.label, m.event_name, m.filters, m.status,
           d.date, s.source, COALESCE(f.count,0)::float8 AS count
    FROM funnel_stage_meta m
    CROSS JOIN dates d
    CROSS JOIN sources s
    LEFT JOIN funnel_daily f
      ON f.stage_key = m.stage_key AND f.date = d.date AND f.source = s.source
  )
  SELECT stage_key AS key, ord, label, event_name AS name, filters, status,
         source, array_agg(count ORDER BY date) AS data, SUM(count)::float8 AS sum
  FROM grid
  GROUP BY stage_key, ord, label, event_name, filters, status, source
  ORDER BY ord, source`;

type FunnelRow = {
  key: string; ord: number; label: string; name: string;
  filters: { property: string; values: string[] }[] | null;
  status: string | null; source: string; data: number[]; sum: number;
};

export async function getFunnel(): Promise<Funnel | null> {
  return withClient(async (c) => {
    const w = await c.query<{ maxd: string | null; gen: Date | null }>(
      `SELECT to_char(MAX(date),'YYYY-MM-DD') AS maxd, MAX(updated_at) AS gen FROM funnel_daily`,
    );
    const maxd = w.rows[0]?.maxd;
    if (!maxd) return null;
    const start = addDays(maxd, -(WINDOW_DAYS - 1));

    // canonical dates 窗口（升序，长度 N）
    const dates: string[] = [];
    for (let i = 0; i < WINDOW_DAYS; i++) dates.push(addDays(start, i));
    const N = dates.length;

    const res = await c.query<FunnelRow>(FUNNEL_SQL, [start, maxd, SOURCES]);

    const byKey = new Map<string, Stage & { _ord: number }>();
    for (const r of res.rows) {
      let st = byKey.get(r.key);
      if (!st) {
        st = { key: r.key, label: r.label, name: r.name, filters: r.filters ?? null, status: r.status ?? "ok", bySource: {}, total: 0, _ord: r.ord };
        byKey.set(r.key, st);
      }
      const data = (r.data || []).map(Number);
      st.bySource[r.source] = { data, sum: Number(r.sum) };
      st.total += Number(r.sum);
    }

    const stages: Stage[] = [...byKey.values()]
      .sort((a, b) => a._ord - b._ord)
      .map(({ _ord, ...s }) => {
        for (const src of SOURCES) if (!s.bySource[src]) s.bySource[src] = { data: Array(N).fill(0), sum: 0 };
        return s;
      });

    return {
      meta: { days: WINDOW_DAYS, sources: SOURCES, generated_at: isoOrNow(w.rows[0]?.gen), app_id: APP_ID },
      dates,
      stages,
    };
  });
}

export async function getStatus() {
  const [snap, fun, pull] = await Promise.all([
    q<{ gen: Date | null }>(`SELECT MAX(updated_at) AS gen FROM campaign_daily`),
    q<{ gen: Date | null }>(`SELECT MAX(updated_at) AS gen FROM funnel_daily`),
    q(`SELECT id, started_at, finished_at, ok, snapshot_ok, funnel_ok, days, start_date, end_date
       FROM pull_runs ORDER BY started_at DESC LIMIT 1`),
  ]);
  return {
    snapshot_generated_at: snap.rows[0]?.gen ? (snap.rows[0].gen as Date).toISOString() : null,
    funnel_generated_at: fun.rows[0]?.gen ? (fun.rows[0].gen as Date).toISOString() : null,
    pull: pull.rows[0] ?? null,
  };
}
