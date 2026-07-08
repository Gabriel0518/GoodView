// 数据口径迁移：补齐提现任务漏斗（任务3/任务4/成材），对齐 数据口径-BytePlus计算方法.md §5.1。
// - 首提(0.5)、任务2({4,5.5,7}) 已存在且正确，不动。
// - 新增：任务3 wd∈{10,20}、任务4 wd=12、成材 = wd=25 OR will_cashout_stage=CashoutStageFive（跨属性 OR，走过滤而非分组）。
// - 成材过滤为多条件 → fetch-funnel 识别为「过滤」路径（buildEventFilter）。
// 幂等：ON CONFLICT DO UPDATE 刷新定义。用法：node db/migrate-caliber.mjs
import { DATABASE_URL } from "../config.mjs";
import { query, withTx, end } from "../lib/db.mjs";

const NEW_STAGES = [
  { key: "withdraw_task3", label: "完成任务3(提现)", name: "pwa_withdraw_audit_apply", filters: [{ property: "withdraw_amount", values: ["10", "20"] }] },
  { key: "withdraw_task4", label: "完成任务4(提现)", name: "pwa_withdraw_audit_apply", filters: [{ property: "withdraw_amount", values: ["12"] }] },
  // 成材：跨属性 OR（withdraw_amount 数字 25，will_cashout_stage 字符串）。多条件 → 过滤路径。
  { key: "chengcai", label: "完成任务5·成材", name: "pwa_withdraw_audit_apply", filters: [{ property: "withdraw_amount", values: [25] }, { property: "will_cashout_stage", values: ["CashoutStageFive"] }] },
];

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL 为空。");

  await withTx(async (c) => {
    const t2 = await c.query(`SELECT ord FROM funnel_stage_meta WHERE stage_key = 'withdraw_task2'`);
    const base = t2.rows[0]?.ord ?? 41;
    // 给新阶段腾位：把 ord > 任务2 的阶段整体后移 3（仅当新阶段尚未插入时）
    const exists = await c.query(`SELECT COUNT(*)::int n FROM funnel_stage_meta WHERE stage_key = 'chengcai'`);
    if (!exists.rows[0].n) {
      await c.query(`UPDATE funnel_stage_meta SET ord = ord + 3 WHERE ord > $1`, [base]);
    }
    // 插入/更新 3 个新阶段（紧跟任务2）
    for (let i = 0; i < NEW_STAGES.length; i++) {
      const s = NEW_STAGES[i];
      await c.query(
        `INSERT INTO funnel_stage_meta (stage_key, ord, label, event_name, filters, enabled, source_split, indicator, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,true,true,'event_users', now())
         ON CONFLICT (stage_key) DO UPDATE SET
           label = EXCLUDED.label, event_name = EXCLUDED.event_name, filters = EXCLUDED.filters, updated_at = now()`,
        [s.key, base + 1 + i, s.label, s.name, JSON.stringify(s.filters)],
      );
    }
  });

  const chk = await query(
    `SELECT stage_key, ord, label, filters FROM funnel_stage_meta
     WHERE stage_key IN ('withdraw_first','withdraw_task2','withdraw_task3','withdraw_task4','chengcai') ORDER BY ord`,
  );
  console.log("✅ 提现任务漏斗：");
  chk.rows.forEach((x) => console.log(`  ord=${x.ord} ${x.stage_key} | ${x.label} | ${JSON.stringify(x.filters)}`));

  await end();
}

main().catch(async (e) => {
  console.error("口径迁移失败：", e.message);
  await end().catch(() => {});
  process.exit(1);
});
