// XMP 素材(ad)级抓取 —— 只拉 lib/pwa-accounts 的活跃 PWA 账户（account_id 过滤，轻量，秒级）。
// 写 ad_daily（按窗口范围 DELETE + INSERT，幂等）。供 daily-adgroup-report 算每个广告组的「可加量素材」。
// 注册不能归因到素材，故素材层只有 CTR/CPC 代理指标（与广告组同款口径）。
// 用法：node fetch-ads.mjs [天数]（默认 10）
import { withTx, bulkInsert, end } from "./lib/db.mjs";
import { fetchReport } from "./lib/xmp.mjs";
import { ACTIVE_PWA_ACCOUNT_IDS, ACTIVE_PWA_ACCOUNTS } from "./lib/pwa-accounts.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const DIM = ["date", "account_name", "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"];
const METRICS = ["cost", "impression", "click"];
const COLS = [
  { name: "date", type: "date" }, { name: "account_id", type: "text" }, { name: "account_name", type: "text" },
  { name: "campaign_id", type: "text" }, { name: "adset_id", type: "text" }, { name: "adset_name", type: "text" },
  { name: "ad_id", type: "text" }, { name: "ad_name", type: "text" },
  { name: "cost", type: "numeric" }, { name: "impression", type: "bigint" }, { name: "click", type: "bigint" },
];

async function main() {
  const days = Number(process.argv[2]) || 10;
  const today = new Date();
  const end_ = new Date(today); end_.setDate(end_.getDate() - 1);   // 昨天（最后完整日）
  const start = new Date(today); start.setDate(start.getDate() - days);
  const [startDate, endDate] = [ymd(start), ymd(end_)];
  if (!ACTIVE_PWA_ACCOUNT_IDS.length) { console.log("[ads] 无活跃账户，跳过。"); return; }
  console.log(`[ads] 拉素材级 ${startDate} ~ ${endDate}（${days}天）· 账户 ${ACTIVE_PWA_ACCOUNTS.map((a) => a.name).join("/")}`);

  // account_id 不是合法 dimension，但可作过滤；每行响应仍自带 account_id。
  const raw = await fetchReport({
    startDate, endDate, dimension: DIM, metrics: METRICS,
    filters: { account_id: ACTIVE_PWA_ACCOUNT_IDS },
  });
  const rows = raw
    .filter((r) => Number(r.cost || 0) > 0 || Number(r.impression || 0) > 0 || Number(r.click || 0) > 0)
    .map((r) => ({
      date: r.date, account_id: String(r.account_id), account_name: r.account_name || "",
      campaign_id: String(r.campaign_id), adset_id: String(r.adset_id || "_"), adset_name: r.adset_name || "_",
      ad_id: String(r.ad_id), ad_name: r.ad_name || "",
      cost: Number(r.cost || 0), impression: Number(r.impression || 0), click: Number(r.click || 0),
    }));

  await withTx(async (c) => {
    // 按窗口范围删（含无数据日），再灌活跃账户的行；移除出活跃集的账户其窗口内行会被清掉。
    await c.query("DELETE FROM ad_daily WHERE date >= $1 AND date <= $2", [startDate, endDate]);
    await bulkInsert(c, "ad_daily", COLS, rows);
  });
  console.log(`[ads] ✅ 写入 ad_daily：${rows.length} 行（素材 ${new Set(rows.map((r) => r.ad_id)).size} 个）`);
}

main()
  .catch((e) => { console.error("[ads] 失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
