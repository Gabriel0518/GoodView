// 8/3 + 8/4 三端汇总：花费 / 注册 / IG授权 / IG绑定 / 单价（上海时区）
// 口径说明见输出末尾的「注意」
import { fetchReport } from "./lib/xmp.mjs";
import { fetchEventDaily } from "./lib/byteplus.mjs";
import { query as pg, end } from "./lib/db.mjs";
import { query as dms } from "./lib/dms.mjs";

const DAYS = ["2026-08-03", "2026-08-04"];
const TZ = "Asia/Shanghai";
const AI_SRC = ["AIguild", "AIguild_active", "AIguild_passive"];

// ---- 1) 花费：按账户归属 + AI公会系列 拆三端 ----
const { rows: cfg } = await pg(
  `SELECT category, value, group_name FROM xmp_fetch_config WHERE enabled`);
const appAcc = new Set(cfg.filter((r) => r.category === "account" && /上架包|smart ?reply/i.test(r.group_name || "")).map((r) => r.value));
const pwaAcc = new Set(cfg.filter((r) => r.category === "account" && !/上架包|smart ?reply/i.test(r.group_name || "")).map((r) => r.value));
const aiCamp = new Set(cfg.filter((r) => r.category === "campaign" && r.group_name === "AI公会").map((r) => r.value));

const spend = { PWA: 0, AI公会: 0, 上架包: 0 };
const spendByDay = {};
for (const d of DAYS) {
  const raw = await fetchReport({ startDate: d, endDate: d,
    dimension: ["date", "account_name", "campaign_id", "campaign_name"], metrics: ["cost"] });
  spendByDay[d] = { PWA: 0, AI公会: 0, 上架包: 0 };
  for (const r of raw) {
    const a = String(r.account_id), c = String(r.campaign_id), v = Number(r.cost) || 0;
    if (!v) continue;
    let k = null;
    if (aiCamp.has(c)) k = "AI公会";
    else if (appAcc.has(a)) k = "上架包";
    else if (pwaAcc.has(a)) k = "PWA";
    if (k) { spend[k] += v; spendByDay[d][k] += v; }
  }
}

// ---- 2) 注册：PWA/AI公会 走业务库（BytePlus 注册事件 08-02 起失效，不能用）----
const inList = `'${AI_SRC.join("','")}'`;
const day = (c) => `((${c} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date`;
const reg = await dms(`
  SELECT ${day("created_at")}::text d,
         count(*) FILTER (WHERE user_source IN (${inList})) ai,
         count(*) FILTER (WHERE user_source IS NULL OR user_source NOT IN (${inList})) pwa
    FROM userinfo WHERE app_name='3'
     AND ${day("created_at")} BETWEEN '${DAYS[0]}' AND '${DAYS[1]}'
     AND ((email<>'' AND email IS NOT NULL) OR (phone_number<>'' AND phone_number IS NOT NULL))
   GROUP BY 1 ORDER BY 1`);

// ---- 3) IG绑定：业务库 t110，同样按 user_source 拆 ----
const bind = await dms(`
  SELECT ${day("t.update_at")}::text d,
         count(DISTINCT t.user_id) FILTER (WHERE u.user_source IN (${inList})) ai,
         count(DISTINCT t.user_id) FILTER (WHERE u.user_source IS NULL OR u.user_source NOT IN (${inList})) pwa
    FROM user_common_task t JOIN userinfo u ON u.user_id=t.user_id AND u.app_name='3'
   WHERE t.task_id='110' AND t.status='FINISHED'
     AND ${day("t.update_at")} BETWEEN '${DAYS[0]}' AND '${DAYS[1]}'
   GROUP BY 1 ORDER BY 1`);

// ---- 4) IG授权：只有 BytePlus 有（PWA 应用，含公会用户，无法按 source 拆）----
const auth = await fetchEventDaily({
  eventName: "pwa_earning_ins_task_page_two_click", lastDays: 4,
  indicator: "event_users", timezone: TZ,
});
const authMap = {}; auth.forEach((r) => { authMap[r.date] = r.count; });

// ---- 5) 上架包：SmartReply 走 AF；Savvy 无数据 ----
const { rows: sr } = await pg(
  `SELECT (event_time AT TIME ZONE $1)::date::text d,
          count(*) FILTER (WHERE event_name='af_login_success') reg,
          count(*) FILTER (WHERE event_name='af_complete_ins_task') ins
     FROM af_events WHERE app_id='whisper.smart.reply'
      AND (event_time AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
    GROUP BY 1 ORDER BY 1`, [TZ, DAYS[0], DAYS[1]]);

const n = (arr, d, k) => Number(arr.find((x) => x.d === d)?.[k] || 0);
const money = (v) => "$" + v.toFixed(2);
const price = (c, u) => (u > 0 ? "$" + (c / u).toFixed(2) : "—");

console.log(`=== ${DAYS[0]} ~ ${DAYS[1]} 汇总（上海时区）===\n`);
console.log("日期         端      花费      注册    注册单价    IG绑定   绑定单价");
const T = { PWA: { c: 0, r: 0, b: 0 }, AI公会: { c: 0, r: 0, b: 0 }, 上架包: { c: 0, r: 0, b: 0 } };
for (const d of DAYS) {
  const rows = [
    ["PWA", spendByDay[d].PWA, n(reg, d, "pwa"), n(bind, d, "pwa")],
    ["AI公会", spendByDay[d]["AI公会"], n(reg, d, "ai"), n(bind, d, "ai")],
    ["上架包", spendByDay[d]["上架包"], n(sr, d, "reg"), n(sr, d, "ins")],
  ];
  for (const [k, c, r, b] of rows) {
    T[k].c += c; T[k].r += r; T[k].b += b;
    console.log(`  ${d}  ${k.padEnd(6)} ${money(c).padStart(9)} ${String(r).padStart(7)} ${price(c, r).padStart(10)} ${String(b).padStart(8)} ${price(c, b).padStart(10)}`);
  }
  console.log(`  ${" ".repeat(10)} IG授权(BytePlus，PWA+公会合计) ${authMap[d] ?? "—"}`);
}

console.log(`\n=== 两天合计 ===`);
console.log("端        花费      注册   注册单价    IG绑定  绑定单价");
let C = 0, R = 0, B = 0;
for (const k of ["PWA", "AI公会", "上架包"]) {
  const t = T[k]; C += t.c; R += t.r; B += t.b;
  console.log(`  ${k.padEnd(7)} ${money(t.c).padStart(9)} ${String(t.r).padStart(7)} ${price(t.c, t.r).padStart(10)} ${String(t.b).padStart(7)} ${price(t.c, t.b).padStart(10)}`);
}
const A = DAYS.reduce((a, d) => a + (authMap[d] ?? 0), 0);
console.log(`  ${"三端合计".padEnd(5)} ${money(C).padStart(9)} ${String(R).padStart(7)} ${price(C, R).padStart(10)} ${String(B).padStart(7)} ${price(C, B).padStart(10)}`);
console.log(`\n  IG授权（BytePlus，仅覆盖 PWA+AI公会）：${A}  单价 ${price(T.PWA.c + T["AI公会"].c, A)}`);
await end();
