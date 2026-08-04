// 三端汇总 —— 与看板同口径（芝加哥时区），可指定日期
// 用法：node summary-cst.mjs 2026-08-02 2026-08-03
import { fetchReport } from "./lib/xmp.mjs";
import { query as pg, end } from "./lib/db.mjs";
import { query as dms } from "./lib/dms.mjs";

const DAYS = process.argv.slice(2).length ? process.argv.slice(2) : ["2026-08-02", "2026-08-03"];
const TZ = "America/Chicago";        // ← 与看板 KEY_METRIC_TIMEZONE 一致
const AI_SRC = ["AIguild", "AIguild_active", "AIguild_passive"];
const inList = `'${AI_SRC.join("','")}'`;
const day = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date`;

const { rows: cfg } = await pg(`SELECT category, value, group_name FROM xmp_fetch_config WHERE enabled`);
const isApp = (g) => /上架包|smart ?reply/i.test(g || "");
const savvyAcc = new Set(cfg.filter((r) => r.category === "account" && /savvy/i.test(r.group_name || "")).map((r) => r.value));
const srAcc = new Set(cfg.filter((r) => r.category === "account" && isApp(r.group_name) && !/savvy/i.test(r.group_name || "")).map((r) => r.value));
const pwaAcc = new Set(cfg.filter((r) => r.category === "account" && !isApp(r.group_name)).map((r) => r.value));
const aiCamp = new Set(cfg.filter((r) => r.category === "campaign" && r.group_name === "AI公会").map((r) => r.value));

const spend = {};
for (const d of DAYS) {
  const raw = await fetchReport({ startDate: d, endDate: d,
    dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"] });
  spend[d] = { PWA: 0, AI公会: 0, SmartReply: 0, Savvy: 0 };
  for (const r of raw) {
    const a = String(r.account_id), c = String(r.campaign_id), v = Number(r.cost) || 0;
    if (!v) continue;
    if (aiCamp.has(c)) spend[d]["AI公会"] += v;
    else if (savvyAcc.has(a)) spend[d].Savvy += v;
    else if (srAcc.has(a)) spend[d].SmartReply += v;
    else if (pwaAcc.has(a)) spend[d].PWA += v;
  }
}

const reg = await dms(`
  SELECT ${day("created_at")}::text d,
         count(*) FILTER (WHERE user_source IN (${inList})) ai,
         count(*) FILTER (WHERE user_source IS NULL OR user_source NOT IN (${inList})) pwa
    FROM userinfo WHERE app_name='3'
     AND ${day("created_at")} BETWEEN '${DAYS[0]}' AND '${DAYS[DAYS.length - 1]}'
     AND ((email<>'' AND email IS NOT NULL) OR (phone_number<>'' AND phone_number IS NOT NULL))
   GROUP BY 1`);
const bind = await dms(`
  SELECT ${day("t.update_at")}::text d,
         count(DISTINCT t.user_id) FILTER (WHERE u.user_source IN (${inList})) ai,
         count(DISTINCT t.user_id) FILTER (WHERE u.user_source IS NULL OR u.user_source NOT IN (${inList})) pwa
    FROM user_common_task t JOIN userinfo u ON u.user_id=t.user_id AND u.app_name='3'
   WHERE t.task_id='110' AND t.status='FINISHED'
     AND ${day("t.update_at")} BETWEEN '${DAYS[0]}' AND '${DAYS[DAYS.length - 1]}'
   GROUP BY 1`);
const { rows: auth } = await pg(
  `SELECT date::text d, count FROM key_metric_daily
    WHERE metric_key='ig_auth' AND region='all' AND date BETWEEN $1::date AND $2::date`,
  [DAYS[0], DAYS[DAYS.length - 1]]);
const { rows: sr } = await pg(
  `SELECT (event_time AT TIME ZONE $1)::date::text d,
          count(*) FILTER (WHERE event_name='af_login_success') reg,
          count(*) FILTER (WHERE event_name='af_complete_ins_task') ins
     FROM af_events WHERE app_id='whisper.smart.reply'
      AND (event_time AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
    GROUP BY 1`, [TZ, DAYS[0], DAYS[DAYS.length - 1]]);

const n = (a, d, k) => Number(a.find((x) => x.d === d)?.[k] || 0);
const m = (v) => "$" + v.toFixed(2);
const p = (c, u) => (u > 0 ? "$" + (c / u).toFixed(2) : "—");

console.log(`=== ${DAYS.join(" ~ ")}（芝加哥时区，与看板同口径）===\n`);
const T = {};
for (const d of DAYS) {
  console.log(`【${d}】`);
  console.log("  端            花费     注册   注册单价   IG绑定  绑定单价");
  const rows = [
    ["PWA", spend[d].PWA, n(reg, d, "pwa"), n(bind, d, "pwa")],
    ["AI公会", spend[d]["AI公会"], n(reg, d, "ai"), n(bind, d, "ai")],
    ["SmartReply", spend[d].SmartReply, n(sr, d, "reg"), n(sr, d, "ins")],
    ["Savvy", spend[d].Savvy, 0, 0],
  ];
  for (const [k, c, r, b] of rows) {
    T[k] = T[k] || { c: 0, r: 0, b: 0 };
    T[k].c += c; T[k].r += r; T[k].b += b;
    const noData = k === "Savvy" && c > 0;
    console.log(`  ${k.padEnd(11)} ${m(c).padStart(9)} ${String(noData ? "无数据" : r).padStart(7)} ${(noData ? "—" : p(c, r)).padStart(9)} ${String(noData ? "无数据" : b).padStart(7)} ${(noData ? "—" : p(c, b)).padStart(9)}`);
  }
  console.log(`  IG授权(BytePlus, PWA+公会)  ${n(auth, d, "count") || "—"}\n`);
}

console.log("=== 合计 ===");
console.log("  端            花费     注册   注册单价   IG绑定  绑定单价");
let C = 0, R = 0, B = 0;
for (const k of ["PWA", "AI公会", "SmartReply", "Savvy"]) {
  const t = T[k]; C += t.c; R += t.r; B += t.b;
  const noData = k === "Savvy" && t.c > 0;
  console.log(`  ${k.padEnd(11)} ${m(t.c).padStart(9)} ${String(noData ? "无数据" : t.r).padStart(7)} ${(noData ? "—" : p(t.c, t.r)).padStart(9)} ${String(noData ? "无数据" : t.b).padStart(7)} ${(noData ? "—" : p(t.c, t.b)).padStart(9)}`);
}
console.log(`  ${"合计".padEnd(10)} ${m(C).padStart(9)} ${String(R).padStart(7)} ${p(C, R).padStart(9)} ${String(B).padStart(7)} ${p(C, B).padStart(9)}`);
const A = DAYS.reduce((a, d) => a + n(auth, d, "count"), 0);
console.log(`\n  IG授权合计 ${A}，单价 ${p(T.PWA.c + T["AI公会"].c, A)}（分母仅 PWA+公会花费）`);
await end();
