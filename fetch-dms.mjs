// 自有后台业务库(DMS) → Postgres dms_metric_daily：IG绑定 / 成材 的业务真实记录。
//
// 为什么用业务库而不是 BytePlus：这些指标在库里是**真实业务记录**（建号行、任务完成行、提现申请行），
// 比前端埋点事件准；BytePlus 的事件还会因为用户属性回溯变动而漂移。2026-07-31 逐日核对，
// 按 America/Chicago 日切齐后：
//   IG绑定  DMS 34/29/25/43/58/64/63  vs BytePlus 34/28/25/43/58/62/63  ← 几乎逐日相同
//   成材    DMS 11/9/14/70/42/26/21   vs BytePlus  7/9/ 7/75/44/28/22   ← 同量级同走势
//
// 【注册为什么也走业务库（2026-07-31 用户拍板）】口径定义仍是「0.5刀提现弹窗曝光」，但那个事件
//   **会对同一个人跨天重复触发**：30 天去重 5598 人、逐日求和 10603 人次（1.9 倍）→ BytePlus 的
//   日 UV 是「当日看到弹窗的人数」，不是「当日新注册」。业务库的建号行天然每人一次，正是日新增。
//   两者在「总共有谁注册了」上是一致的：30 天 BytePlus 去重 5598 vs 业务库建号 5034（差 10%）。
//   （试过给 BytePlus 加官方的新用户条件 user_is_new=1，7 天只剩 763，比业务库 1372 更严，不合用。）
//
// ⚠️ 只出**全量**口径，没有地区维度：业务库切不了德州（user_geo_location.province 脏——大量字面量
//    '0'、城市名混进州名列、运营商名进 city；zip_code 只有 16% 覆盖）。德州/非德州仍由 BytePlus 提供。
//
// 用法：node fetch-dms.mjs [天数]   默认 30 天
import { query as dmsQuery, dayExpr, enabled } from "./lib/dms.mjs";
import { KEY_METRIC_TIMEZONE } from "./lib/key-metrics.mjs";
import { withTx, bulkInsert, end } from "./lib/db.mjs";

const DAYS = Number(process.argv[2]) || 30;
const TZ = KEY_METRIC_TIMEZONE; // America/Chicago，与 key_metric_daily 同一天界
const COLS = [
  { name: "date", type: "date" },
  { name: "metric_key", type: "text" },
  { name: "count", type: "bigint" },
];

// 注意：task_id / amount 在业务库是 varchar，字面量必须带引号，否则报
// operator does not exist: character varying = integer
const METRICS = [
  {
    key: "register",
    label: "注册",
    // 口径 = 账号建行（每人一次）。app_name='3' 就是 PWA 产品（映射表未登记，靠数据反推：
    // 它是唯一存邮箱的 app(88.8%)，且 IG绑定 与 BytePlus 逐日一致）。
    //
    // ⚠️ **过滤掉空壳账号**（无邮箱且无手机）——这些是"建了号但还没填资料"的用户（用户 2026-07-31 说明）。
    // 按已定口径「注册 = 0.5刀提现弹窗曝光」，他们还没走到那一步，本就不该计入注册。
    // 不过滤的风险很实在：2026-07-31 当天建号 860 行里 571 行是空壳（384 个集中在 UTC 02:00 一小时内，
    // 邮箱率从常态 76~100% 掉到 32%），会把注册虚报成 ~800（完成注册实际 289）。
    // 建号总数另存为 register_all，两个并列展示。
    // 「有邮箱或手机」这一路口径很稳：7/25~7/31 = 38/148/179/228/255/276/289，无突刺。
    // PWA 走 Google 登录必有邮箱，留手机是为了兼容别的登录方式。
    sql: (from) => `SELECT ${dayExpr("created_at", TZ)} AS d, count(*) AS n
                      FROM userinfo
                     WHERE app_name = '3' AND created_at >= '${from}'
                       AND ((email IS NOT NULL AND email <> '')
                         OR (phone_number IS NOT NULL AND phone_number <> ''))
                     GROUP BY 1 ORDER BY 1`,
  },
  {
    key: "register_all",
    label: "建号总数",
    // 不过滤的建号总数（含"注册了但还没填资料"的空壳）。与 register 并存，看板上并列展示，
    // 便于发现异常批量灌入（2026-07-31 那次：860 建号 vs 289 完成注册）。
    sql: (from) => `SELECT ${dayExpr("created_at", TZ)} AS d, count(*) AS n
                      FROM userinfo
                     WHERE app_name = '3' AND created_at >= '${from}'
                     GROUP BY 1 ORDER BY 1`,
  },
  {
    key: "ig_bind",
    label: "IG绑定",
    // ⚠️ 必须 join userinfo 限定 app_name='3'：user_common_task 是全产品共用表。
    //    2026-07-31 起 app_name=32 这个新产品也开始产生 task_id=110，不筛就混进 PWA 看板
    //    （08-03 实测 37 里有 15 个是 app32 的，占 41%，把 PWA 的真实跌幅盖住了）。
    //    去重也要：同一用户理论上一条，但 count(*) 没有防重语义。
    sql: (from) => `SELECT ${dayExpr("t.update_at", TZ)} AS d, count(DISTINCT t.user_id) AS n
                      FROM user_common_task t
                      JOIN userinfo u ON u.user_id = t.user_id AND u.app_name = '3'
                     WHERE t.task_id = '110' AND t.status = 'FINISHED' AND t.update_at >= '${from}'
                     GROUP BY 1 ORDER BY 1`,
  },
  {
    key: "chengcai",
    label: "成材",
    // 对齐 BytePlus 的 pwa_withdraw_audit_apply（申请动作）→ 按 create_at、不筛 status
    // 同样 join userinfo 限定 app_name='3'（当前非 PWA 提现为 0，但表是全产品共用的，先防住）
    sql: (from) => `SELECT ${dayExpr("w.create_at", TZ)} AS d, count(*) AS n
                      FROM user_withdraw_task w
                      JOIN userinfo u ON u.user_id = w.user_id AND u.app_name = '3'
                     WHERE w.amount = '25' AND w.create_at >= '${from}'
                     GROUP BY 1 ORDER BY 1`,
  },
];

async function main() {
  if (!enabled()) {
    console.log("[dms] 未配置 DMS_TOKEN，跳过（看板回退到 BytePlus 口径）。");
    return;
  }
  const t0 = Date.now();
  // 多往前取 2 天，覆盖时区换算的边界日
  const fromD = new Date();
  fromD.setUTCDate(fromD.getUTCDate() - (DAYS + 2));
  const from = fromD.toISOString().slice(0, 10);
  console.log(`拉取业务库关键指标（最近 ${DAYS} 天，按 ${TZ} 日切）\n`);

  const rows = [];
  const failed = [];
  const summary = [];
  for (const m of METRICS) {
    try {
      const res = await dmsQuery(m.sql(from));
      let n = 0;
      for (const r of res) {
        const d = String(r.d).slice(0, 10);
        rows.push({ date: d, metric_key: m.key, count: Number(r.n) || 0 });
        n += Number(r.n) || 0;
      }
      summary.push(`${m.label} ${res.length} 天 / 合计 ${n}`);
    } catch (e) {
      failed.push(`${m.label}: ${e.message.slice(0, 80)}`);
    }
  }

  if (!rows.length) {
    console.log("❌ 没取到数据，跳过写库，保留原值");
    failed.forEach((f) => console.log(`   - ${f}`));
    await end();
    process.exit(1);
  }

  const dates = [...new Set(rows.map((r) => r.date))];
  const keys = [...new Set(rows.map((r) => r.metric_key))];
  await withTx(async (c) => {
    await c.query(
      `DELETE FROM dms_metric_daily WHERE date = ANY($1::date[]) AND metric_key = ANY($2::text[])`,
      [dates, keys],
    );
    await bulkInsert(c, "dms_metric_daily", COLS, rows);
  });

  console.log(summary.map((s) => `  ${s}`).join("\n"));
  console.log(`\n✅ [dms] 已写入 Postgres：${rows.length} 行（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  if (failed.length) {
    console.log(`⚠️ ${failed.length} 个指标失败（保留旧数据）：`);
    failed.forEach((f) => console.log(`   - ${f}`));
  }
  await end();
}

main().catch(async (e) => {
  console.error("[dms] 失败：", e.message);
  await end().catch(() => {});
  process.exit(1);
});
