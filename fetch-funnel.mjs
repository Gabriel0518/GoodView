// 拉取完整漏斗：启用的阶段 × 按 source 拆分(fb/tt/bff/AIguild/active/passive/unknown) → 写 Postgres。
// P1.2 起：事件定义从 DB(funnel_stage_meta WHERE enabled) 读取，不再 import funnel-events.mjs（后者仅作 migrate 种子）。
// 加速：① 合并同名事件(如 pwa_task_complete 7 个 stage → 1 组请求) ② 组间并发(池) ③ unknown=全量−已知源
// 用法：node fetch-funnel.mjs [天数] [并发数]   默认 30 天、并发 6
import { fetchEventDaily, fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { pMap } from "./lib/http.mjs";
import { query, withTx, bulkInsert, end } from "./lib/db.mjs";

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

// 从 DB 读启用的事件定义（DB 为权威源）。filters 为 jsonb → pg 自动解析为 JS 对象。
async function loadFunnelDefs() {
  const { rows } = await query(
    `SELECT stage_key AS key, ord, label, event_name AS name, filters, source_split, indicator
       FROM funnel_stage_meta WHERE enabled = true ORDER BY ord`,
  );
  return rows.map((r) => ({
    key: r.key, ord: r.ord, label: r.label, name: r.name,
    filters: r.filters || null,
    source_split: r.source_split,
    indicator: r.indicator || "event_users",
  }));
}

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
// source_split=false：不按 source 拆，日总额全部记到 unknown（known 全 0）。复用 fillUnknown。
function totalOnly(totalPerDay, nDays) {
  const bySource = emptyBySource();
  for (const s of KNOWN) bySource[s] = { data: Array(nDays).fill(0), sum: 0 };
  fillUnknown(bySource, totalPerDay, nDays);
  return bySource;
}

// 把同一 (event_name + 过滤属性 + indicator + source_split) 的 stage 合并成一个请求组。
// source_split/indicator 不同的同名事件不能共用一次请求，故进 key。
function buildGroups(defs) {
  const map = new Map();
  for (const st of defs) {
    const f = (st.filters || [])[0];
    const base = f ? `${st.name}|${f.property}` : `solo:${st.key}`;
    const key = `${base}|${st.indicator}|${st.source_split}`;
    if (!map.has(key)) {
      map.set(key, { name: st.name, property: f?.property || null, indicator: st.indicator, source_split: st.source_split, stages: [] });
    }
    map.get(key).stages.push(st);
  }
  return [...map.values()];
}

// 拉一个组，返回 { [stageKey]: {bySource, dates, status} }
async function fetchGroup(group) {
  const out = {};
  const ind = group.indicator;

  if (!group.property) {
    const st = group.stages[0];
    if (!group.source_split) {
      // 只拉日总额，记到 unknown
      const totalDaily = await fetchEventDaily({ eventName: st.name, lastDays: DAYS, indicator: ind });
      const dates = totalDaily.map((x) => x.date);
      const bySource = totalOnly(totalDaily.map((x) => x.count), dates.length);
      out[st.key] = { bySource, dates, status: "ok(no-split)" };
      return out;
    }
    const [grouped, totalDaily] = await Promise.all([
      fetchEventDailyGrouped({ eventName: st.name, lastDays: DAYS, groupBy: "source", propertyType: "profile", groupLocation: "content", indicator: ind }),
      fetchEventDaily({ eventName: st.name, lastDays: DAYS, indicator: ind }),
    ]);
    const bySource = pickSingle(grouped.series);
    fillUnknown(bySource, totalDaily.map((x) => x.count), grouped.dates.length);
    out[st.key] = { bySource, dates: grouped.dates, status: "ok" };
    return out;
  }

  // 有过滤属性
  const propGroup = { property_name: group.property, property_type: "event_param", location: "event" };
  if (!group.source_split) {
    // 只按属性分组一次（不按 source）；每个 stage 取其 value 的总额 → 记到 unknown
    const resTotal = await fetchEventDailyGrouped({ eventName: group.name, lastDays: DAYS, groups: [propGroup], indicator: ind });
    for (const st of group.stages) {
      const vals = st.filters[0].values;
      const total = totalsFromValueDim(resTotal.series, vals);
      out[st.key] = { bySource: totalOnly(total, resTotal.dates.length), dates: resTotal.dates, status: `ok(by ${group.property}, no-split)` };
    }
    return out;
  }
  // 一次二维分组(source×属性) + 一次单维(属性)分组，覆盖该 event 的所有 stage
  const [res, resTotal] = await Promise.all([
    fetchEventDailyGrouped({ eventName: group.name, lastDays: DAYS, groups: [{ property_name: "source", property_type: "profile", location: "content" }, propGroup], indicator: ind }),
    fetchEventDailyGrouped({ eventName: group.name, lastDays: DAYS, groups: [propGroup], indicator: ind }),
  ]);
  for (const st of group.stages) {
    const vals = st.filters[0].values;
    const bySource = pickComposite(res.series, vals);
    fillUnknown(bySource, totalsFromValueDim(resTotal.series, vals), res.dates.length);
    out[st.key] = { bySource, dates: res.dates, status: `ok(by ${group.property})` };
  }
  return out;
}

// 过滤路径（多条件跨属性 OR，如成材=wd25 OR CashoutStageFive；分组匹配单值做不到）。
// 用官方过滤格式(buildEventFilter) + 始终排测试用户；source_split 时用 source 分组 + 全量补 unknown。
async function fetchFilteredStage(def) {
  const filters = def.filters; // [{property,values},...] → 同一 OR 组
  const ind = def.indicator;
  if (!def.source_split) {
    const totalDaily = await fetchEventDaily({ eventName: def.name, lastDays: DAYS, indicator: ind, filters });
    const dates = totalDaily.map((x) => x.date);
    return { key: def.key, bySource: totalOnly(totalDaily.map((x) => x.count), dates.length), dates, status: "ok(filter,no-split)" };
  }
  const [grouped, totalDaily] = await Promise.all([
    fetchEventDailyGrouped({ eventName: def.name, lastDays: DAYS, groupBy: "source", propertyType: "profile", groupLocation: "content", indicator: ind, filters }),
    fetchEventDaily({ eventName: def.name, lastDays: DAYS, indicator: ind, filters }),
  ]);
  const bySource = pickSingle(grouped.series);
  fillUnknown(bySource, totalDaily.map((x) => x.count), grouped.dates.length);
  return { key: def.key, bySource, dates: grouped.dates, status: "ok(filter)" };
}

async function main() {
  const t0 = Date.now();
  const defs = await loadFunnelDefs();
  if (!defs.length) {
    console.error("[funnel] funnel_stage_meta 无启用阶段（先跑 node db/migrate.mjs 播种）。跳过。");
    await end();
    process.exit(1);
  }
  // 多条件过滤（跨属性 OR，如成材）走过滤路径；其余走分组路径。
  const filterDefs = defs.filter((d) => (d.filters?.length || 0) >= 2);
  const groupDefs = defs.filter((d) => (d.filters?.length || 0) < 2);
  const groups = buildGroups(groupDefs);
  console.log(`拉取完整漏斗（最近 ${DAYS} 天，${defs.length} 启用阶段：${groups.length} 分组请求 + ${filterDefs.length} 过滤阶段，并发 ${CONCURRENCY}）\n`);

  const [groupResults, filterResults] = await Promise.all([
    pMap(groups, fetchGroup, CONCURRENCY),
    pMap(filterDefs, fetchFilteredStage, CONCURRENCY),
  ]);

  // 合并所有组结果
  const byKey = {};
  let dates = [];
  groupResults.forEach((r, gi) => {
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
  filterResults.forEach((r, i) => {
    if (r && r.__error) { byKey[filterDefs[i].key] = { status: `失败:${String(r.__error.message).replace(/\s+/g, " ").slice(0, 28)}` }; return; }
    byKey[r.key] = r;
    if (r.dates?.length) dates = r.dates;
  });

  const stages = [];
  console.log(`${pad("阶段", 22)} ${SOURCES.map((s) => pad(s, 8)).join(" ")} ${pad("合计", 9)} 状态`);
  for (const def of defs) {
    const r = byKey[def.key] || {};
    const bySource = r.bySource || emptyBySource();
    const status = r.status || "失败:无结果";
    const total = SOURCES.reduce((a, s) => a + (bySource[s]?.sum || 0), 0);
    stages.push({ key: def.key, label: def.label, name: def.name, filters: def.filters || null, status, bySource, total });
    console.log(`${pad(def.label, 22)} ${SOURCES.map((s) => pad(bySource[s]?.sum ?? 0, 8)).join(" ")} ${pad(total, 9)} ${status}`);
  }

  const bad = stages.filter((s) => s.status.startsWith("失败"));
  if (bad.length === stages.length) {
    console.log(`\n❌ 全部失败（网络问题？），已跳过写库，保留原数据`);
    await end();
    process.exit(1);
  }

  // 只回写运行时 status（定义字段以 DB 为权威源，不覆盖）。一条 unnest 批量更新，
  // 少 47 次往返 → 更快、也少一次中途被 proxy 掐断导致 status 半写。
  await query(
    `UPDATE funnel_stage_meta m SET status = v.status, updated_at = now()
       FROM unnest($1::text[], $2::text[]) AS v(stage_key, status)
      WHERE m.stage_key = v.stage_key`,
    [stages.map((s) => s.key), stages.map((s) => s.status)],
  );

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
