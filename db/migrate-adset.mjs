// P1.1 迁移：给【已有】campaign_daily 加 adset_id/adset_name 维度并改主键。
// 幂等：可重复执行。对全新库（schema.sql 已含 adset 列）也安全 —— 各步都用 IF (NOT) EXISTS / 条件判断。
// 用法：node db/migrate-adset.mjs
import { DATABASE_URL } from "../config.mjs";
import { query, withTx, end } from "../lib/db.mjs";

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL 为空。请在 .env 里设置连接串后重试。");
  }
  console.log(`连接 ${DATABASE_URL.replace(/:[^:@/]+@/, ":****@")} …`);

  // 表可能尚不存在（全新库先跑 migrate.mjs）。存在才迁移。
  const exists = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'campaign_daily'`,
  );
  if (!exists.rows.length) {
    console.log("campaign_daily 不存在，跳过（请先跑 node db/migrate.mjs 建表）。");
    await end();
    return;
  }

  await withTx(async (c) => {
    // 1) 加列（占位默认 '_'，让已有行先有值）
    await c.query(`ALTER TABLE campaign_daily ADD COLUMN IF NOT EXISTS adset_id   text NOT NULL DEFAULT '_'`);
    await c.query(`ALTER TABLE campaign_daily ADD COLUMN IF NOT EXISTS adset_name text NOT NULL DEFAULT '_'`);

    // 2) 回填历史空值为占位（DEFAULT 已覆盖新加列，这里兜底 NULL / 空串）
    const filled = await c.query(
      `UPDATE campaign_daily
         SET adset_id   = COALESCE(NULLIF(adset_id,   ''), '_'),
             adset_name = COALESCE(NULLIF(adset_name, ''), '_')
       WHERE adset_id IS NULL OR adset_id = '' OR adset_name IS NULL OR adset_name = ''`,
    );
    if (filled.rowCount) console.log(`  回填 ${filled.rowCount} 行 adset 占位`);

    // 3) 保证 NOT NULL（加列时已 NOT NULL，兜底幂等）
    await c.query(`ALTER TABLE campaign_daily ALTER COLUMN adset_id   SET NOT NULL`);
    await c.query(`ALTER TABLE campaign_daily ALTER COLUMN adset_name SET NOT NULL`);

    // 4) 主键改为 (date, account_id, campaign_id, adset_id)。
    //    仅当现有主键不含 adset_id 时才重建（幂等）。
    const pk = await c.query(
      `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'campaign_daily'::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)`,
    );
    const pkCols = pk.rows.map((r) => r.col);
    const wantCols = ["date", "account_id", "campaign_id", "adset_id"];
    const same = pkCols.length === wantCols.length && pkCols.every((c2, i) => c2 === wantCols[i]);
    if (same) {
      console.log(`  主键已是 (${pkCols.join(", ")})，无需重建`);
    } else {
      const con = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'campaign_daily'::regclass AND contype = 'p'`,
      );
      if (con.rows.length) {
        await c.query(`ALTER TABLE campaign_daily DROP CONSTRAINT ${con.rows[0].conname}`);
        console.log(`  已删旧主键 ${con.rows[0].conname}（原列: ${pkCols.join(", ") || "?"}）`);
      }
      await c.query(
        `ALTER TABLE campaign_daily ADD PRIMARY KEY (date, account_id, campaign_id, adset_id)`,
      );
      console.log(`  已建新主键 (${wantCols.join(", ")})`);
    }
  });

  // 校验结果
  const chk = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM information_schema.columns
           WHERE table_name='campaign_daily' AND column_name IN ('adset_id','adset_name')) AS cols,
        (SELECT COUNT(*)::int FROM campaign_daily) AS rows`,
  );
  console.log(`✅ adset 迁移完成：adset 列数=${chk.rows[0].cols}/2，campaign_daily 行数=${chk.rows[0].rows}`);

  await end();
}

main().catch(async (e) => {
  console.error("adset 迁移失败：");
  console.error("  message:", e?.message || "(空)");
  console.error("  code   :", e?.code || "-");
  if (e?.cause) console.error("  cause  :", e.cause);
  await end().catch(() => {});
  process.exit(1);
});
