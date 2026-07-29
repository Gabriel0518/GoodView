// AF 事件名发现/映射工具 —— 上架包漏斗的口径由这里定。
//
// 背景：AF 的 event_name 由 app 埋点决定，只有 install 是 AF 协议固定的标准事件；
// 注册/IG授权这类各 app 各叫各的，XMP 侧又完全没有自定义事件字段（128 个指标里最细只到
// 安装/注册/付费，且这些 MMP 字段对 Google 上架包账户实测全是 0）。所以事件名只能从
// AF 真实报文里认，认完写进 af_event_map，af_events join 它就得到分阶段人数。
//
// 用法：
//   node af-events.mjs                     列出 af_events 里出现过的事件名 + 映射状态
//   node af-events.mjs map <事件名> <stage_key> <中文名> [ord]   建立映射
//   node af-events.mjs unmap <事件名>       删除映射
import { query, end } from "./lib/db.mjs";

async function list() {
  const { rows } = await query(`
    SELECT e.event_name,
           count(*)                          AS events,
           -- appsflyer_id 是 AF 可选字段，没勾就不发 → 回退到 GAID/IDFA/android_id 认设备
           count(DISTINCT COALESCE(e.appsflyer_id, e.advertising_id, e.idfa, e.android_id)) AS devices,
           min(e.event_time)                 AS first_seen,
           max(e.event_time)                 AS last_seen,
           count(*) FILTER (WHERE e.customer_user_id IS NOT NULL) AS with_cuid,
           m.stage_key, m.label, m.ord
    FROM af_events e
    LEFT JOIN af_event_map m ON m.af_event_name = e.event_name
    GROUP BY e.event_name, m.stage_key, m.label, m.ord
    ORDER BY count(*) DESC`);

  if (!rows.length) {
    console.log("af_events 还没有任何事件。\n");
  } else {
    console.log(`\n=== af_events 里出现过的事件名（${rows.length} 个）===`);
    for (const r of rows) {
      const mapped = r.stage_key ? `✅ ${r.label}(${r.stage_key})` : "⚠️  未映射";
      console.log(`  ${String(r.event_name).padEnd(30)} ${String(r.events).padStart(6)} 次 / ${String(r.devices).padStart(6)} 设备  CUID ${r.with_cuid}  ${mapped}`);
      console.log(`  ${" ".repeat(30)} ${r.first_seen?.toISOString?.() || r.first_seen} ~ ${r.last_seen?.toISOString?.() || r.last_seen}`);
    }
  }

  // 映射表里配了、但 AF 一次都没推过来的 —— 名字大概率写错了，早点发现
  const { rows: unseen } = await query(`
    SELECT m.af_event_name, m.stage_key, m.label FROM af_event_map m
    WHERE m.enabled AND NOT EXISTS (SELECT 1 FROM af_events e WHERE e.event_name = m.af_event_name)
    ORDER BY m.ord`);
  if (unseen.length) {
    console.log(`\n⚠️  映射表里配了但 AF 从没推过的事件（${unseen.length} 个，检查事件名是否写错）：`);
    unseen.forEach((r) => console.log(`  ${String(r.af_event_name).padEnd(30)} → ${r.label}(${r.stage_key})`));
  }

  const { rows: cur } = await query("SELECT af_event_name, stage_key, label, ord, enabled FROM af_event_map ORDER BY ord, af_event_name");
  console.log(`\n=== 当前映射（af_event_map，${cur.length} 条）===`);
  cur.forEach((r) => console.log(`  ${String(r.ord).padStart(2)}. ${String(r.af_event_name).padEnd(30)} → ${String(r.label).padEnd(12)} ${r.stage_key}${r.enabled ? "" : "  (停用)"}`));
}

async function map(name, stageKey, label, ord) {
  if (!name || !stageKey || !label) throw new Error("用法：node af-events.mjs map <事件名> <stage_key> <中文名> [ord]");
  await query(
    `INSERT INTO af_event_map (af_event_name, stage_key, label, ord, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (af_event_name) DO UPDATE
       SET stage_key = EXCLUDED.stage_key, label = EXCLUDED.label, ord = EXCLUDED.ord, updated_at = now()`,
    [name, stageKey, label, Number(ord) || 0],
  );
  console.log(`✅ ${name} → ${label}(${stageKey})`);
}

const [cmd, ...args] = process.argv.slice(2);
const run =
  cmd === "map" ? map(args[0], args[1], args[2], args[3])
  : cmd === "unmap" ? query("DELETE FROM af_event_map WHERE af_event_name = $1", [args[0]]).then((r) => console.log(`删除 ${r.rowCount} 条`))
  : list();

run.catch((e) => { console.error("失败：", e.message); process.exitCode = 1; }).finally(() => end().catch(() => {}));
