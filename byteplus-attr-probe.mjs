// 归因探测：IG授权(及可选其它)事件上，哪个属性带了「XMP 广告系列/广告」级标识？
// 逐个试候选属性名(先事件属性 event_param，无则用户属性 profile)，打印取值。
// 用法：node byteplus-attr-probe.mjs [event_name]   默认 IG授权事件
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const DAYS = 30;
const EVENT = process.argv[2] || BYTEPLUS.igAuthEvent;

// 常见的广告归因属性名（UTM / 平台 id / clickid）
const CANDS = [
  "utm_campaign", "utm_source", "utm_medium", "utm_content", "utm_term",
  "campaign_id", "campaign_name", "campaign", "adset_id", "adset_name",
  "ad_id", "ad_name", "adgroup", "adgroup_id", "pid", "cid",
  "click_id", "clickid", "fbclid", "gclid", "ttclid", "ad", "creative_id",
];

// 看着像 campaign/ad 标识的值：含 0617 / Form / 长数字ID
const looksAd = (v) => /0617|form|customer|campaign|\b\d{12,}\b/i.test(String(v));

async function probe(name) {
  for (const type of ["event_param", "profile"]) {
    try {
      const res = await fetchEventDailyGrouped({
        eventName: EVENT, lastDays: DAYS, groupBy: name,
        propertyType: type, groupLocation: type === "profile" ? "content" : "event",
      });
      const groups = [...res.series].sort((a, b) => b.sum - a.sum);
      if (groups.length === 1 && groups[0].group === "__all") continue; // 该类型下不可分组
      return { type, groups };
    } catch {
      // 换下一个 type
    }
  }
  return null;
}

async function main() {
  console.log(`事件「${EVENT}」最近 ${DAYS} 天 —— 探测广告归因属性\n`);
  const hits = [];

  for (const name of CANDS) {
    const r = await probe(name);
    if (!r) {
      console.log(`  ${name.padEnd(14)} → 无此属性/不可分组`);
      continue;
    }
    const vals = r.groups.slice(0, 6).map((g) => `${g.group}(${g.sum})`);
    const flag = r.groups.some((g) => looksAd(g.group)) ? "  ⭐ 像广告标识" : "";
    console.log(`✔ ${name.padEnd(14)} [${r.type}] → ${vals.join(", ")}${r.groups.length > 6 ? " …" : ""}${flag}`);
    if (flag) hits.push(name);
  }

  console.log("");
  if (hits.length) {
    console.log(`✅ 可能的归因字段：${hits.join(", ")}`);
    console.log("   → 用它把 IG授权 归因到 XMP 广告系列（下一步我据此改脚本）。");
  } else {
    console.log("⚠️ 没有任何候选属性带 campaign/ad 级标识。");
    console.log("   说明 BytePlus 事件里没采集广告参数，只能归因到 source(fb/tt/bff/AIguild) 渠道级。");
    console.log("   要精确到广告系列，需在广告落地页 URL 加 UTM 并让 BytePlus 采集。");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
