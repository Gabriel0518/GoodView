// ad_groups 成员展开（.mjs 版，用 lib/db.mjs 的 query）。
// 对应 app/lib/groups.ts 的 resolveGroupToCampaignIds —— TS 版用的是 app/lib/db，无法跨模块复用，故在此重写同款逻辑。
import { query } from "./db.mjs";

// 组 → 去重的 campaign_id 集合。account 成员展开为其下全部 campaign；campaign 成员即自身；重叠只算一次。
export async function resolveGroupToCampaignIds(members) {
  const list = members || [];
  const accountIds = list.filter((m) => m.type === "account").map((m) => m.id);
  const set = new Set(list.filter((m) => m.type === "campaign").map((m) => m.id));
  if (accountIds.length) {
    const { rows } = await query(
      `SELECT DISTINCT campaign_id FROM campaign_daily WHERE account_id = ANY($1::text[])`,
      [accountIds],
    );
    for (const r of rows) set.add(r.campaign_id);
  }
  return [...set];
}

// 读全部广告分组。
export async function loadAdGroups() {
  const { rows } = await query(
    `SELECT id, name, members, is_app_group FROM ad_groups ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name || "",
    members: Array.isArray(r.members) ? r.members : [],
    is_app_group: !!r.is_app_group,
  }));
}
