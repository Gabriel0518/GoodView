// 拉取完整漏斗：47 阶段 × 按 source 拆分(fb/tt/bff/AIguild/active/passive/unknown) → 写 Postgres。
// 加速：① 合并同名事件(如 pwa_task_complete 7 个 stage → 1 组请求) ② 组间并发(池) ③ unknown=全量−已知源
// 用法：node fetch-funnel.mjs [天数] [并发数]   默认 30 天、并发 6
import { fetchEventDaily, fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { pMap } from "./lib/http.mjs";
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";
import { FUNNEL } from "./funnel-events.mjs";
import { BYTEPLUS } from "./config.mjs";

const DAYS = Number(process.argv[2]) || 30;
const CONCURRENCY = Number(process.argv[3]) || 6;
const KNOWN = ["fb", "tt", "bff", "AIguild", "AIguild_active", "AIguild_passive"];
const SOURCES = [...KNOWN, "unknown"];
const pad = (s, n) => String(s).padEnd(n);
const FUNNEL_COLS = [
  { name: "date", type: "date" },
  { name: "stage_key", type: "text" },
  { name: "source", type: "text" },
  { name: "count", type: "bigint" },
];

const emptyBySource = () => Object.fromEntries(SOURCES.map((s) => [s, { data: [], sum: 0 }]));

function pickSingle(series) {
  const out = emptyBySource();
  for (const row of series) if (out[row.group]) out[row.group] = { data: row.data, sum: row.sum };
  return out;
}
function pickComposite(series, wantValues) {
  const out = emptyBySource();
  for (const row of series) {
    const idx = String(row.group).indexOf(",");
    const src = String(row.group).slice(0, idx);
    const val = String(row.group).slice(idx + 1);
    if (!out[src]) continue;
    if (wantValues && !wantValues.includes(val)) continue;
    out[src].sum += row.sum;
    row.data.forEach((n, i) => { out[src].data[i] = (out[src].data[i] || 0) + n; });
  }
  return out;
}
function totalsFromValueDim(series, wantValues) {
  const data = [];
  for (const row of series) {
    if (wantValues && !wantValues.includes(String(row.group))) continue;
    row.data.forEach((n, i) => { data[i] = (data[i] || 0) + n; });
  }
  return data;
}
function fillUnknown(bySource, totalPerDay, nDays) {
  const data = [];
  for (let i = 0; i < nDays; i++) {
    const known = KNOWN.reduce((a, s) => a + (bySource[s].data[i] || 0), 0);
    data[i] = Math.max(0, (totalPerDay[i] || 0) - known);
  }
  bySource.unknown = { data, sum: data.reduce((a, b) => a + b, 0) };
}

// 把同一 (event_name + 过滤属性) 的 stage 合并成一个请求组
function buildGroups() {
  const map = new Map();
  for (const st of FUNNEL) {
    const f = (st.filters || [])[0];
    const key = f ? `${st.name}|${f.property}` : `solo:${st.key}`;
    if (!map.has(key)) map.set(key, { name: st.name, property: f?.property || null, stages: [] });
    map.get(key).stages.push(st);
  }
  return [...map.values()];
}

// 拉一个组，返回 { [stageKey]: {bySource, dates, status} }
async function fetchGroup(group) {
  const out = {};
  if (!group.property) {
    const st = group.stages[0];
    const [grouped, totalDaily] = await Promise.all([
      fetchEventDailyGrouped({ eventName: st.name, lastDays: DAYS, groupBy: "source", propertyType: "profile", groupLocation: "content" }),
      fetchEventDaily({ eventName: st.name, lastDays: DAYS }),
    ]);
    const bySource = pickSingle(grouped.series);
    fillUnknown(bySource, totalDaily.map((x) => x.count), grouped.dates.length);
    out[st.key] = { bySource, dates: grouped.dates, status: "ok" };
    return out;
  }
  // 有过滤属性：一次二维分组 + 一次单维(属性)分组，覆盖该 event 的所有 stage
  const propGroup = { property_name: group.property, property_type: "event_param", location: "event" };
  const [res, resTotal] = await Promise.all([
    fetchEventDailyGrouped({ eventName: group.name, lastDays: DAYS, groups: [{ property_name: "source", property_type: "profile", location: "content" }, propGroup] }),
    fetchEventDailyGrouped({ eventName: group.name, lastDays: DAYS, groups: [propGroup] }),
  ]);
  for (const st of group.stages) {
    const vals = st.filters[0].values;
    const bySource = pickComposite(res.series, vals);
    fillUnknown(bySource, totalsFromValueDim(resTotal.series, vals), res.dates.length);
    out[st.key] = { bySource, dates: res.dates, status: `ok(by ${group.property})` };
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const groups = buildGroups();
  console.log(`拉取完整漏斗（最近 ${DAYS} 天，${FUNNEL.length} 阶段合并为 ${groups.length} 组请求，并发 ${CONCURRENCY}）\n`);

  const results = await pMap(groups, fetchGroup, CONCURRENCY);

  // 合并所有组结果
  const byKey = {};
  let dates = [];
  results.forEach((r, gi) => {
    if (r && r.__error) {
      // 整组失败：把组内所有 stage 标失败
      for (const st of groups[gi].stages) byKey[st.key] = { status: `失败:${String(r.__error.message).replace(/\s+/g, " ").slice(0, 28)}` };
      return;
    }
    for (const [k, v] of Object.entries(r)) {
      byKey[k] = v;
      if (v.dates?.length) dates = v.dates;
    }
  });

  const stages = [];
  console.log(`${pad("阶段", 22)} ${SOURCES.map((s) => pad(s, 8)).join(" ")} ${pad("合计", 9)} 状态`);
  for (const stage of FUNNEL) {
    const r = byKey[stage.key] || {};
    const bySource = r.bySource || emptyBySource();
    const status = r.status || "失败:无结果";
    const total = SOURCES.reduce((a, s) => a + (bySource[s]?.sum || 0), 0);
    stages.push({ key: stage.key, label: stage.label, name: stage.name, filters: stage.filters || null, status, bySource, total });
    console.log(`${pad(stage.label, 22)} ${SOURCES.map((s) => pad(bySource[s]?.sum ?? 0, 8)).join(" ")} ${pad(total, 9)} ${status}`);
  }

  const bad = stages.filter((s) => s.status.startsWith("失败"));
  if (bad.length === stages.length) {
    console.log(`\n❌ 全部失败（网络问题？），已跳过写库，保留原数据`);
    await end();
    process.exit(1);
  }

  // 同步 funnel_stage_meta（ord/label/event_name/filters/status）
  for (let ord = 0; ord < stages.length; ord++) {
    const s = stages[ord];
    await query(
      `INSERT INTO funnel_stage_meta (stage_key, ord, label, event_name, filters, status, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6, now())
       ON CONFLICT (stage_key) DO UPDATE SET
         ord=EXCLUDED.ord, label=EXCLUDED.label, event_name=EXCLUDED.event_name,
         filters=EXCLUDED.filters, status=EXCLUDED.status, updated_at=now()`,
      [s.key, ord, s.label, s.name, s.filters ? JSON.stringify(s.filters) : null, s.status],
    );
  }

  // funnel_daily：只对成功阶段做「按(日期,阶段)删除 + 插入」，失败阶段保留旧数据
  const okStages = stages.filter((s) => !s.status.startsWith("失败"));
  const okKeys = okStages.map((s) => s.key);
  const rows = [];
  for (const s of okStages) {
    for (const src of SOURCES) {
      const data = s.bySource[src]?.data || [];
      for (let i = 0; i < dates.length; i++) {
        rows.push({ date: dates[i], stage_key: s.key, source: src, count: data[i] || 0 });
      }
    }
  }
  if (rows.length) {
    await withTx(async (c) => {
      await c.query(
        "DELETE FROM funnel_daily WHERE date = ANY($1::date[]) AND stage_key = ANY($2::text[])",
        [dates, okKeys],
      );
      await bulkInsert(c, "funnel_daily", FUNNEL_COLS, rows);
    });
  }

  console.log(`\n✅ [funnel] 已写入 Postgres：${okStages.length}/${stages.length} 阶段，${rows.length} 行（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  if (bad.length) {
    console.log(`⚠️ ${bad.length} 个阶段失败（保留旧数据）：`);
    bad.forEach((s) => console.log(`   - ${s.label} (${s.name}) ${s.status}`));
  }
  await end();
}

main().catch(async (e) => {
  console.error("[funnel] 失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  await end().catch(() => {});
  process.exit(1);
});
