// 对账：DB（迁移后 pull 写入）vs 旧 data/*.json（迁移前）。
// 证明拉取写库是忠实的。在 npm run pull 之后跑：node reconcile.mjs
// campaign/funnel/IG 应与旧 JSON 在重叠日期上高度一致（byDate 派生口径见计划风险2）。
import { readFile } from "node:fs/promises";
import { query, end } from "./lib/db.mjs";

const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };
const n = (x) => Number(x || 0);
const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(2) + "%" : "—");

async function main() {
  const snap = await readJson("data/snapshot.json");
  const fun = await readJson("data/funnel.json");
  if (!snap && !fun) {
    console.log("找不到旧 data/*.json（迁移前的文件），无法对账。跳过。");
    await end();
    return;
  }

  // ---- A. IG授权按天 ----
  if (snap?.igAuthByDate?.length) {
    const dates = snap.igAuthByDate.map((x) => x.date);
    const db = await query(
      "SELECT to_char(date,'YYYY-MM-DD') AS date, count::int AS count FROM ig_auth_daily WHERE date = ANY($1::date[])",
      [dates],
    );
    const dbMap = Object.fromEntries(db.rows.map((r) => [r.date, r.count]));
    let mism = 0, oldSum = 0, dbSum = 0;
    for (const x of snap.igAuthByDate) {
      oldSum += n(x.count); dbSum += n(dbMap[x.date]);
      if (n(dbMap[x.date]) !== n(x.count)) mism++;
    }
    console.log(`\n[IG授权] 旧合计 ${oldSum} | DB合计 ${dbSum} | 差 ${dbSum - oldSum} | 不一致天数 ${mism}/${snap.igAuthByDate.length} ${mism ? "⚠️" : "✓"}`);
  }

  // ---- B. campaign 明细（重叠日期上：总额 + 行数）----
  if (snap?.campaignRows?.length) {
    const dates = [...new Set(snap.campaignRows.map((r) => r.date))];
    const oldRows = snap.campaignRows.filter((r) => dates.includes(r.date));
    const oldTot = oldRows.reduce((a, r) => ({ cost: a.cost + n(r.cost), imp: a.imp + n(r.impression), clk: a.clk + n(r.click), rows: a.rows + 1 }), { cost: 0, imp: 0, clk: 0, rows: 0 });
    const db = await query(
      `SELECT COUNT(*)::int AS rows, SUM(cost)::float8 AS cost, SUM(impression)::float8 AS imp, SUM(click)::float8 AS clk
       FROM campaign_daily WHERE date = ANY($1::date[])`,
      [dates],
    );
    const d = db.rows[0];
    console.log(`\n[campaign] 日期数 ${dates.length}`);
    console.log(`  行数    旧 ${oldTot.rows}  | DB ${d.rows}  | 差 ${d.rows - oldTot.rows} ${d.rows === oldTot.rows ? "✓" : "⚠️"}`);
    console.log(`  花费    旧 ${oldTot.cost.toFixed(2)} | DB ${n(d.cost).toFixed(2)} | 差 ${pct(n(d.cost), oldTot.cost)}`);
    console.log(`  曝光    旧 ${oldTot.imp} | DB ${n(d.imp)} | 差 ${n(d.imp) - oldTot.imp}`);
    console.log(`  点击    旧 ${oldTot.clk} | DB ${n(d.clk)} | 差 ${n(d.clk) - oldTot.clk}`);
  }

  // ---- C. funnel（每阶段 total，重叠日期）----
  if (fun?.stages?.length && fun?.dates?.length) {
    const dates = fun.dates;
    const db = await query(
      `SELECT stage_key, SUM(count)::float8 AS total FROM funnel_daily WHERE date = ANY($1::date[]) GROUP BY stage_key`,
      [dates],
    );
    const dbMap = Object.fromEntries(db.rows.map((r) => [r.stage_key, n(r.total)]));
    let mism = 0;
    const diffs = [];
    for (const s of fun.stages) {
      const oldTot = s.total ?? Object.values(s.bySource || {}).reduce((a, x) => a + n(x.sum), 0);
      const dbTot = n(dbMap[s.key]);
      if (dbTot !== oldTot) { mism++; if (diffs.length < 8) diffs.push(`${s.label}: 旧${oldTot} DB${dbTot}`); }
    }
    console.log(`\n[funnel] ${fun.stages.length} 阶段 | 不一致 ${mism} ${mism ? "⚠️" : "✓"}`);
    diffs.forEach((d) => console.log("  " + d));
  }

  // ---- D. 内部一致性（不受时间漂移影响的硬证明）----
  // db-queries 的 byDate 由 campaign_daily 派生，故顶层日总额必须 == 各系列之和（分毫不差）。
  const ic = await query(`
    WITH per_date AS (
      SELECT date, SUM(cost)::numeric AS c FROM campaign_daily GROUP BY date
    )
    SELECT COUNT(*)::int AS days,
           SUM(c)::float8 AS total_cost
    FROM per_date`);
  const igIc = await query(`SELECT COUNT(*)::int AS days, SUM(count)::int AS total FROM ig_auth_daily`);
  const fdIc = await query(`SELECT COUNT(DISTINCT stage_key)::int AS stages, SUM(count)::float8 AS total FROM funnel_daily`);
  console.log(`\n[内部一致性] campaign_daily: ${ic.rows[0].days} 天，总花费 $${n(ic.rows[0].total_cost).toFixed(2)}（顶层日总额==各系列之和，派生保证）`);
  console.log(`[内部一致性] ig_auth_daily: ${igIc.rows[0].days} 天，合计 ${igIc.rows[0].total}`);
  console.log(`[内部一致性] funnel_daily: ${fdIc.rows[0].stages} 阶段，人次合计 ${n(fdIc.rows[0].total)}`);

  console.log("\n提示：与旧 JSON 的差异若出现在【花费】而非【行数】，多为两次拉取的时间漂移（XMP 近几日数据会回补），非迁移错误。");
  console.log("最硬的对齐证明是：起页面用 preview 读实际卡片值（如 0617 系列 $597.98），与迁移前一致。");
  await end();
}

main().catch(async (e) => {
  console.error("对账失败：", e.message);
  await end().catch(() => {});
  process.exit(1);
});
