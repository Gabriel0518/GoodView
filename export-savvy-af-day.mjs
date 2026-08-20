// 导出 Savvy 某一天的 AF 原始回传（**安卓 + iOS 一起**，按上海日切）。
// 用法：node export-savvy-af-day.mjs [YYYY-MM-DD]     默认昨天(上海)
//
// 【关于 customer id】AF 推给我们的 payload 里**没有** customer_user_id / appsflyer_id
//   —— Savvy 安卓 25257 条事件，这两个顶层字段 100% 为空。raw 里出现过的 key 全部枚举过，
//   压根没有 customer_user_id。业务用户 ID 藏在 **event_value.user_id**（= 业务库 userinfo.user_id，
//   抽样 200 个命中 194 个、其中 189 个 app_name=32）。
//   ⚠️ 只有 pwa_* 自定义事件带它；AF SDK 自带事件（install / af_google_login_* / af_onboarding_completed
//      等）没有 —— 那时候用户还没建号。要按人贯通含安装的全漏斗，只能用 af_device_id 或设备广告 ID。
//
// 【跨端】app_id 安卓是包名、iOS 是 id<AppStoreID>，靠 resolveSavvyAfAppIds 自动发现（见 lib/xiaomei.mjs）。
//   端上区分：安卓有 advertising_id(GAID)，iOS 有 idfa/idfv；platform 字段 Savvy 没回传，不能靠它。
import { query, end } from "./lib/db.mjs";
import { resolveSavvyAfAppIds } from "./lib/xiaomei.mjs";
import fs from "node:fs/promises";

const TZ = "Asia/Shanghai";
const yesterdayShanghai = () => {
  const t = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const DAY = process.argv[2] || yesterdayShanghai();

const csv = (rows, hdr) => [hdr.join(","), ...rows.map((r) => hdr.map((h) => {
  const v = r[h] ?? "";
  return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
}).join(","))].join("\n");

// 端：Savvy 不回传 platform，用设备广告 ID 反推（GAID=安卓，IDFA/IDFV=iOS）
const PLAT = `CASE WHEN COALESCE(NULLIF(platform,''), '') <> '' THEN platform
                   WHEN COALESCE(idfa, idfv, raw->>'idfa', raw->>'idfv') IS NOT NULL THEN 'ios'
                   WHEN COALESCE(advertising_id, raw->>'advertising_id') IS NOT NULL THEN 'android'
                   ELSE '未知' END`;

const APP_IDS = await resolveSavvyAfAppIds(query);
console.log(`Savvy 的 AF app_id：${APP_IDS.join(", ")}`);

// 先看这天有没有数、分端各多少 —— iOS 端点刚配好，可能还没有量
const { rows: mix } = await query(
  `SELECT app_id, ${PLAT} AS 端, count(*) AS 事件数,
          count(DISTINCT event_value->>'user_id') AS 去重user_id
     FROM af_events
    WHERE app_id = ANY($2::text[]) AND (event_time AT TIME ZONE $3)::date = $1::date
    GROUP BY 1,2 ORDER BY 3 DESC`, [DAY, APP_IDS, TZ]);
console.log(`\n=== ${DAY}（上海日）分端 ===`);
if (!mix.length) console.log("  （这天没有任何 Savvy 的 AF 回传）");
else console.table(mix);

const { rows: users } = await query(
  `SELECT event_value->>'user_id' AS user_id, max(app_id) AS app_id, max(${PLAT}) AS 端,
          max(event_value->>'af_device_id') AS af_device_id,
          max(COALESCE(advertising_id, idfa, idfv)) AS 设备广告id,
          max(media_source) AS media_source, max(campaign) AS campaign,
          min(event_time AT TIME ZONE $3)::text AS 首个事件,
          max(event_time AT TIME ZONE $3)::text AS 末个事件,
          count(*) AS 事件数,
          count(*) FILTER (WHERE event_name='pwa_conv_cash_ready_pop_show') AS 注册弹窗,
          count(*) FILTER (WHERE event_name='pwa_user_face_score') AS 人脸打分,
          count(*) FILTER (WHERE event_name='pwa_golive_enter') AS golive,
          count(*) FILTER (WHERE event_name='pwa_withdraw_audit_apply') AS 提现申请
     FROM af_events
    WHERE app_id = ANY($2::text[]) AND (event_time AT TIME ZONE $3)::date = $1::date
      AND event_value->>'user_id' IS NOT NULL
    GROUP BY 1 ORDER BY 10 DESC`, [DAY, APP_IDS, TZ]);

const { rows: events } = await query(
  `SELECT (event_time AT TIME ZONE $3)::text AS 事件时间_上海, app_id, ${PLAT} AS 端,
          event_name, media_source, campaign, adset, ad,
          event_value->>'user_id' AS user_id, event_value->>'af_device_id' AS af_device_id,
          COALESCE(advertising_id, idfa, idfv) AS 设备广告id,
          country_code, event_value::text AS event_value
     FROM af_events
    WHERE app_id = ANY($2::text[]) AND (event_time AT TIME ZONE $3)::date = $1::date
    ORDER BY event_time`, [DAY, APP_IDS, TZ]);

await fs.mkdir("outputs", { recursive: true });
const f1 = `outputs/savvy-af-${DAY}-用户级.csv`;
const f2 = `outputs/savvy-af-${DAY}-事件级.csv`;
await fs.writeFile(f1, csv(users, ["user_id","app_id","端","af_device_id","设备广告id","media_source","campaign","首个事件","末个事件","事件数","注册弹窗","人脸打分","golive","提现申请"]));
await fs.writeFile(f2, csv(events, ["事件时间_上海","app_id","端","event_name","media_source","campaign","adset","ad","user_id","af_device_id","设备广告id","country_code","event_value"]));
console.log(`\n✅ ${f1}  ${users.length} 个业务 user_id`);
console.log(`✅ ${f2}  ${events.length} 条原始事件`);
await end();
