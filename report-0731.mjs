// 7/31 三块口径统计：PWA全量 / 德州定向系列 / SmartReply上架包
import { query, end } from "./lib/db.mjs";

const D = "2026-07-31";
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const price = (c, n) => (n > 0 ? `$${(c / n).toFixed(2)}` : "—");
const TXP = "texas|德州|德克萨斯";

// ---------- 1) PWA 花费（口径账户，剔上架包 + 剔 AI公会系列），按上海账户日 ----------
const { rows: sp } = await query(
  `WITH acc AS (SELECT value FROM xmp_fetch_config WHERE category='account' AND enabled
                  AND (group_name IS NULL OR group_name !~* '上架包|smart ?reply')),
        guild AS (SELECT jsonb_array_elements(members)->>'id' AS id FROM ad_groups WHERE name ~* 'AI公会|AIguild|公会')
   SELECT COALESCE(SUM(cost),0)::float8 AS all_cost,
          COALESCE(SUM(cost) FILTER (WHERE campaign_name ~* $2),0)::float8 AS tx_cost,
          COALESCE(SUM(cost) FILTER (WHERE campaign_name ~* $2 AND channel='facebook'),0)::float8 AS tx_fb,
          COALESCE(SUM(cost) FILTER (WHERE campaign_name ~* $2 AND channel='tiktok'),0)::float8 AS tx_tt
     FROM campaign_daily
    WHERE date=$1 AND account_id IN (SELECT value FROM acc) AND campaign_id NOT IN (SELECT id FROM guild)`,
  [D, TXP]);
const s = sp[0];

// ---------- 2) 转化 ----------
// 全量：业务库日新增（每人一次）；德州：只有 BytePlus（含回访日 UV）
const { rows: dms } = await query(
  `SELECT metric_key, count FROM dms_metric_daily WHERE date=$1`, [D]);
const dm = Object.fromEntries(dms.map((r) => [r.metric_key, Number(r.count)]));
const { rows: bp } = await query(
  `SELECT region, metric_key, count FROM key_metric_daily WHERE date=$1`, [D]);
const bpm = {};
for (const r of bp) (bpm[r.region] ||= {})[r.metric_key] = Number(r.count);

// ---------- 3) SmartReply ----------
const { rows: srSpend } = await query(
  `WITH app AS (SELECT value FROM xmp_fetch_config WHERE category='account' AND enabled
                  AND group_name ~* '上架包|smart ?reply')
   SELECT COALESCE(SUM(c.cost),0)::float8 AS cost,
          COALESCE((SELECT SUM(m.value) FROM campaign_metric_daily m
                     WHERE m.metric_key='conversion' AND m.date=$1
                       AND m.account_id IN (SELECT value FROM app)),0)::float8 AS installs
     FROM campaign_daily c
    WHERE c.date=$1 AND c.account_id IN (SELECT value FROM app)`, [D]);
const sr = srSpend[0];
// AF：注册 af_login_success、IG绑定 af_complete_ins_task、安装 install（按芝加哥日）
const { rows: af } = await query(
  `SELECT event_name, count(DISTINCT customer_user_id) AS uids, count(*) AS n
     FROM af_events
    WHERE app_id='whisper.smart.reply'
      AND (event_time AT TIME ZONE 'America/Chicago')::date = $1
    GROUP BY event_name`, [D]);
const afm = Object.fromEntries(af.map((r) => [r.event_name, { uids: Number(r.uids), n: Number(r.n) }]));

const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
console.log(`===== ${D} 统计 =====\n`);

console.log("【PWA 全量】（花费=上海账户日，已剔上架包与AI公会系列；转化=业务库日新增·每人一次）");
line("广告消耗", money(s.all_cost));
line("注册数", dm.register ?? "—");
line("注册单价", price(s.all_cost, dm.register));
line("IG绑定数", dm.ig_bind ?? "—");
line("IG绑定单价", price(s.all_cost, dm.ig_bind));

console.log("\n【德州定向系列】（花费=系列名含 texas；转化=BytePlus 德州·含回访口径）");
line("广告消耗", `${money(s.tx_cost)}  (FB ${money(s.tx_fb)} + TT ${money(s.tx_tt)})`);
line("注册数", bpm.TX?.register ?? "—");
line("注册单价", price(s.tx_cost, bpm.TX?.register));
line("IG绑定数", bpm.TX?.ig_bind ?? "—");
line("IG绑定单价", price(s.tx_cost, bpm.TX?.ig_bind));

console.log("\n【同尺度参照】PWA全量也按 BytePlus 含回访口径（好和德州直接比）");
line("注册数(含回访)", bpm.all?.register ?? "—");
line("注册单价", price(s.all_cost, bpm.all?.register));
line("IG绑定数", bpm.all?.ig_bind ?? "—");
line("IG绑定单价", price(s.all_cost, bpm.all?.ig_bind));

console.log("\n【SmartReply 上架包】（花费=4个SR账户；安装=XMP转化数；注册/IG=AppsFlyer）");
line("广告消耗", money(sr.cost));
line("安装数(XMP转化)", sr.installs);
line("安装单价", price(sr.cost, sr.installs));
line("注册数(af_login_success)", afm.af_login_success?.uids ?? 0);
line("注册单价", price(sr.cost, afm.af_login_success?.uids));
line("IG绑定数(af_complete_ins_task)", afm.af_complete_ins_task?.uids ?? 0);
line("IG绑定单价", price(sr.cost, afm.af_complete_ins_task?.uids));
line("参考: AF install 事件", afm.install?.n ?? 0);

await end();
