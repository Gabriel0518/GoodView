import { q } from "./db";

export type GroupMember = { type: "account" | "campaign"; id: string; name?: string };
export type AdGroup = { id: number; name: string; members: GroupMember[]; is_app_group: boolean };

// 组 → 去重的 campaign_id 集合。
// account 成员展开为其下全部 campaign；campaign 成员即自身；重叠只算一次。
// 供查询层 `WHERE campaign_id = ANY(集合)` 求和，天然去重、不叠加。
export async function resolveGroupToCampaignIds(members: GroupMember[]): Promise<string[]> {
  const accountIds = members.filter((m) => m.type === "account").map((m) => m.id);
  const set = new Set<string>(members.filter((m) => m.type === "campaign").map((m) => m.id));
  if (accountIds.length) {
    const r = await q<{ campaign_id: string }>(
      `SELECT DISTINCT campaign_id FROM campaign_daily WHERE account_id = ANY($1::text[])`,
      [accountIds],
    );
    for (const row of r.rows) set.add(row.campaign_id);
  }
  return [...set];
}

// 候选：账户 / 系列 + 花费（供组管理页勾选）。按花费降序。
export async function listCandidates(): Promise<{
  accounts: { id: string; name: string; cost: number }[];
  campaigns: { id: string; name: string; account_id: string; cost: number }[];
}> {
  const accounts = await q<{ id: string; name: string; cost: number }>(
    `SELECT account_id AS id, MAX(account_name) AS name, SUM(cost)::float8 AS cost
     FROM campaign_daily GROUP BY account_id ORDER BY SUM(cost) DESC`,
  );
  const campaigns = await q<{ id: string; name: string; account_id: string; cost: number }>(
    `SELECT campaign_id AS id, MAX(campaign_name) AS name, MAX(account_id) AS account_id, SUM(cost)::float8 AS cost
     FROM campaign_daily GROUP BY campaign_id ORDER BY SUM(cost) DESC`,
  );
  return { accounts: accounts.rows, campaigns: campaigns.rows };
}
