// P2.7 播种默认看板：近30日 花费 + 触达 走势（幂等：已有看板则跳过）。
// 数据源默认全渠道；用户在 /admin/groups 建 PWA 组后，可把看板数据源切到该组（修成本失真）。
// 用法：node db/seed-default-dashboard.mjs
import { DATABASE_URL } from "../config.mjs";
import { query, withTx, end } from "../lib/db.mjs";

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL 为空。");

  const existing = await query("SELECT COUNT(*)::int n FROM dashboards");
  if (existing.rows[0].n > 0) {
    console.log(`已有 ${existing.rows[0].n} 个看板，跳过默认看板播种。`);
    await end();
    return;
  }

  // 若已存在 PWA 组（is_app_group）则默认用它，否则全渠道
  const pwa = await query("SELECT id FROM ad_groups WHERE is_app_group = true ORDER BY id LIMIT 1");
  const groupId = pwa.rows[0]?.id ?? null;

  const boardFilters = {
    window: "d30",
    granularity: "day",
    ...(groupId ? { groupId } : {}),
  };

  await withTx(async (c) => {
    const d = await c.query(
      `INSERT INTO dashboards (name, board_filters, is_template) VALUES ($1,$2::jsonb,false) RETURNING id`,
      ["默认看板", JSON.stringify(boardFilters)],
    );
    const dashId = d.rows[0].id;
    const cards = [
      {
        title: "花费走势",
        config: { measure: "cost", params: {}, dims: ["date"], viz: "line" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
        ord: 0,
      },
      {
        title: "触达走势（投广页曝光）",
        config: { measure: "people", params: { stage: "lp_show" }, dims: ["date"], viz: "line" },
        layout: { x: 6, y: 0, w: 6, h: 4 },
        ord: 1,
      },
    ];
    for (const card of cards) {
      await c.query(
        `INSERT INTO cards (dashboard_id, title, config, layout, ord) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)`,
        [dashId, card.title, JSON.stringify(card.config), JSON.stringify(card.layout), card.ord],
      );
    }
    console.log(`✅ 默认看板已播种（id=${dashId}，${cards.length} 卡片，数据源=${groupId ? "PWA组#" + groupId : "全渠道"}）`);
  });

  await end();
}

main().catch(async (e) => {
  console.error("默认看板播种失败：", e.message);
  await end().catch(() => {});
  process.exit(1);
});
