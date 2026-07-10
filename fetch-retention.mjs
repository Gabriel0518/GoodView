// 拉取 BytePlus 留存报表（sitin 看板）→ 解析全体同期群留存曲线 → 写 Postgres retention_summary。
// 留存数据来自 BytePlus（非 Postgres 事实表），这里落一张快照表，再由 sync-to-feishu 照常镜像到飞书。
// 用法：node fetch-retention.mjs
import { getReport, postAnalysis } from "./lib/byteplus.mjs";
import { query, end } from "./lib/db.mjs";

// sitin 看板里的留存报表（report_type=custom_retention_analysis）。category 决定进哪张飞书表。
const REPORTS = [
  { id: "7655247435131798021", name: "用户留存",        category: "user",     ord: 1 },
  { id: "7657445701122523653", name: "注册用户留存",     category: "user",     ord: 2 },
  { id: "7657462553127158325", name: "下载APP用户留存",  category: "user",     ord: 3 },
  { id: "7657843653313823237", name: "成材小利女留存",   category: "chengcai", ord: 1 },
  { id: "7657843714009596469", name: "新成材小利女留存", category: "chengcai", ord: 2 },
];

// summary = [group, 当日基数, [次日人数,率], [第3日,率], ...]；summary[1]=当日, summary[1+n]=第(n+1)日。
// 取 次日(idx2)/第3日(idx3)/第7日(idx7)/第14日(idx14)/第30日(idx30) 的留存率（%）。
const pct = (arr, i) => (Array.isArray(arr?.[i]) && typeof arr[i][1] === "number" ? Math.round(arr[i][1] * 1000) / 10 : null);

async function pullOne(rep) {
  const j = await getReport(rep.id);
  const dslc = j.data?.dsls?.[0]?.dsl_content;
  if (!dslc) throw new Error(`报表 ${rep.name} 无 dsl_content`);
  const dsl = typeof dslc === "string" ? JSON.parse(dslc) : dslc;
  const r = await postAnalysis(dsl);
  if (r.code !== 200) throw new Error(`报表 ${rep.name} 查询失败 code=${r.code} ${r.message || ""}`);
  const summary = r.data?.[0]?.data_item_list?.[0]?.summary;
  if (!Array.isArray(summary)) throw new Error(`报表 ${rep.name} 无 summary`);
  return {
    ...rep,
    base: Number(summary[1]) || 0,
    r1: pct(summary, 2), r3: pct(summary, 3), r7: pct(summary, 7), r14: pct(summary, 14), r30: pct(summary, 30),
  };
}

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS retention_summary (
      category    text        NOT NULL,
      ord         int         NOT NULL,
      report_id   text        NOT NULL PRIMARY KEY,
      report_name text        NOT NULL,
      base_users  bigint      NOT NULL DEFAULT 0,
      r_d1  numeric, r_d3 numeric, r_d7 numeric, r_d14 numeric, r_d30 numeric,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`);

  console.log(`[留存] 拉取 ${REPORTS.length} 张报表…`);
  const rows = [];
  for (const rep of REPORTS) {
    try {
      const d = await pullOne(rep);
      rows.push(d);
      console.log(`  ✅ ${d.name}：当日 ${d.base} · 次日 ${d.r1}% · 7日 ${d.r7}% · 14日 ${d.r14}% · 30日 ${d.r30}%`);
    } catch (e) {
      console.error(`  ❌ ${rep.name}：${e.message}`);
    }
  }
  if (!rows.length) throw new Error("无留存数据");

  // 快照全量替换
  await query(`DELETE FROM retention_summary`);
  for (const d of rows) {
    await query(
      `INSERT INTO retention_summary (category,ord,report_id,report_name,base_users,r_d1,r_d3,r_d7,r_d14,r_d30,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [d.category, d.ord, d.id, d.name, d.base, d.r1, d.r3, d.r7, d.r14, d.r30],
    );
  }
  console.log(`[留存] 写库完成，${rows.length} 行。`);
}

main().catch((e) => { console.error("fetch-retention 失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
