// 导出 Savvy 安卓端 2026-08-19（上海日）的 AF 回传原始数据。
//
// 【关于 customer id】AF 推给我们的 payload 里**没有** customer_user_id / appsflyer_id
//   —— Savvy 全量 25210 条事件，这两个顶层字段 100% 为空。raw 里出现过的 key 只有：
//   media_source / bundle_id / campaign / event_name / event_source / event_time /
//   install_time / is_retargeting / af_adset(_id) / af_channel / af_c_id / api_version /
//   app_id / attributed_touch_time(_type) / advertising_id / af_ad(_id) /
//   event_revenue_currency / event_value / af_siteid / af_ad_type
//   业务用户 ID 藏在 **event_value.user_id** 里（= 业务库 userinfo.user_id），
//   只有 pwa_* 自定义事件带；AF SDK 自带事件（install / af_google_login_* 等）没有。
//   设备维度另有 event_value.af_device_id（AF 设备 ID）和 advertising_id（GAID，安卓）。
import { query, end } from "./lib/db.mjs";
import fs from "node:fs/promises";

const TZ = "Asia/Shanghai";
const DAY = process.argv[2] || "2026-08-19";
const APP = "com.gigpulse.savvy";
const csv = (rows, hdr) => [hdr.join(","), ...rows.map((r) => hdr.map((h) => {
  const v = r[h] ?? "";
  return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
}).join(","))].join("\n");

// ① 用户级：一行一个业务 user_id
const { rows: users } = await query(
  `SELECT event_value->>'user_id' AS user_id,
          max(event_value->>'af_device_id') AS af_device_id,
          max(advertising_id) AS gaid,
          max(media_source) AS media_source,
          max(campaign) AS campaign,
          min(event_time AT TIME ZONE $2)::text AS 首个事件,
          max(event_time AT TIME ZONE $2)::text AS 末个事件,
          count(*) AS 事件数,
          count(*) FILTER (WHERE event_name='pwa_conv_cash_ready_pop_show') AS 注册弹窗,
          count(*) FILTER (WHERE event_name='pwa_user_face_score') AS 人脸打分,
          count(*) FILTER (WHERE event_name='pwa_golive_enter') AS golive,
          count(*) FILTER (WHERE event_name='pwa_withdraw_audit_apply') AS 提现申请
     FROM af_events
    WHERE app_id=$3 AND (event_time AT TIME ZONE $2)::date=$1::date
      AND event_value->>'user_id' IS NOT NULL
    GROUP BY 1 ORDER BY 8 DESC`, [DAY, TZ, APP]);

// ② 事件级：全部原始行
const { rows: events } = await query(
  `SELECT (event_time AT TIME ZONE $2)::text AS 事件时间_上海,
          event_name, media_source, campaign, adset, ad,
          event_value->>'user_id' AS user_id,
          event_value->>'af_device_id' AS af_device_id,
          advertising_id AS gaid,
          country_code, event_value::text AS event_value
     FROM af_events
    WHERE app_id=$3 AND (event_time AT TIME ZONE $2)::date=$1::date
    ORDER BY event_time`, [DAY, TZ, APP]);

const f1 = `outputs/savvy-android-${DAY}-用户级.csv`;
const f2 = `outputs/savvy-android-${DAY}-事件级.csv`;
await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(f1, csv(users, ["user_id","af_device_id","gaid","media_source","campaign","首个事件","末个事件","事件数","注册弹窗","人脸打分","golive","提现申请"]));
await fs.writeFile(f2, csv(events, ["事件时间_上海","event_name","media_source","campaign","adset","ad","user_id","af_device_id","gaid","country_code","event_value"]));
console.log(`✅ ${f1}  ${users.length} 个业务 user_id`);
console.log(`✅ ${f2}  ${events.length} 条原始事件`);
console.log(`\n用户级前 10 行：`);
console.table(users.slice(0, 10));
await end();
