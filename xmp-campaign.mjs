// 取指定 campaign 的层级（campaign → adset → ad）及其花费/曝光/点击
// 用法：node xmp-campaign.mjs ["campaign 名字"]   默认 "0617_Customer Form_1"
import { fetchReport } from "./lib/xmp.mjs";

const NAME = process.argv[2] || "0617_Customer Form_1";
const DAYS = 30;
const M = ["cost", "impression", "click"];

const ymd = (d) => d.toISOString().slice(0, 10);
const num = (r) => ({ cost: Number(r.cost) || 0, impression: Number(r.impression) || 0, click: Number(r.click) || 0 });
const fmt = (o) => `花费 $${o.cost.toFixed(2)} | 曝光 ${o.impression} | 点击 ${o.click}`;
const add = (a, b) => ({ cost: a.cost + b.cost, impression: a.impression + b.impression, click: a.click + b.click });

async function main() {
  const today = new Date();
  const end = new Date(today); end.setDate(end.getDate() - 1);
  const start = new Date(today); start.setDate(start.getDate() - DAYS);
  const [startDate, endDate] = [ymd(start), ymd(end)];
  console.log(`范围 ${startDate} ~ ${endDate}，查找 campaign：「${NAME}」\n`);

  // 1) 按 campaign 维度找到匹配的 campaign_id（可能跨多个广告账户重名）
  const camps = await fetchReport({ startDate, endDate, dimension: ["campaign_id", "campaign_name"], metrics: M });
  const lc = NAME.toLowerCase();
  let matches = camps.filter((c) => (c.campaign_name || "").toLowerCase() === lc);
  if (!matches.length) matches = camps.filter((c) => (c.campaign_name || "").toLowerCase().includes(lc));

  if (!matches.length) {
    console.log("没找到该 campaign。范围内前 20 个 campaign 名供你核对：");
    camps.slice(0, 20).forEach((c) => console.log("  -", c.campaign_name, `(id=${c.campaign_id})`));
    return;
  }

  for (const c of matches) {
    const cid = c.campaign_id;
    console.log(`■ Campaign: ${c.campaign_name}  (id=${cid})`);
    console.log(`   ${fmt(num(c))}`);

    // 2) 该 campaign 下的 ad 明细（带 adset 归属），按 adset 归组
    const ads = await fetchReport({
      startDate, endDate,
      dimension: ["adset_id", "adset_name", "ad_id", "ad_name"],
      metrics: M,
      filters: { campaign_id: [cid] },
    });

    const adsets = {};
    for (const a of ads) {
      const g = (adsets[a.adset_id] ||= { name: a.adset_name, tot: { cost: 0, impression: 0, click: 0 }, ads: [] });
      const v = num(a);
      g.tot = add(g.tot, v);
      g.ads.push({ id: a.ad_id, name: a.ad_name, ...v });
    }

    for (const [aid, g] of Object.entries(adsets)) {
      console.log(`   ├─ Adset: ${g.name}  (id=${aid})  ${fmt(g.tot)}`);
      for (const ad of g.ads) {
        console.log(`   │    └─ Ad: ${ad.name}  (id=${ad.id})  ${fmt(ad)}`);
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
