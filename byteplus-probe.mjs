// 探测 IG授权事件下「哪个用户属性字段」承载了主动/被动(active/passive)区分。
// 用已跑通的「用户属性(profile)分组」逐个试候选字段名，打印每个字段的实际取值。
// 用法：node byteplus-probe.mjs [天数]   默认 30
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const DAYS = Number(process.argv[2]) || 30;

// 候选字段名（归因/类型相关）——按可能性排序
const CANDIDATES = [
  "source", "sub_source", "second_source", "channel", "sub_channel",
  "medium", "utm_source", "utm_medium", "utm_campaign", "utm_content",
  "ad_type", "type", "traffic_type", "guild_type", "entry_type",
  "entrance", "reg_source", "active_type", "mode", "user_source",
];

const isInteresting = (v) => /active|passive|guild/i.test(String(v));

async function probe(name) {
  const res = await fetchEventDailyGrouped({
    eventName: BYTEPLUS.igAuthEvent, lastDays: DAYS, groupBy: name,
    propertyType: "profile", groupLocation: "content",
  });
  return [...res.series].sort((a, b) => b.sum - a.sum);
}

async function main() {
  console.log(`探测事件「${BYTEPLUS.igAuthEvent}」最近 ${DAYS} 天，逐个候选字段分组\n`);
  const hits = [];

  for (const name of CANDIDATES) {
    try {
      const groups = await probe(name);
      if (groups.length === 1 && groups[0].group === "__all") {
        console.log(`  ${name.padEnd(16)} → __all（该字段不可分组/无值）`);
        continue;
      }
      const vals = groups.map((g) => `${g.group}(${g.sum})`);
      const flag = groups.some((g) => isInteresting(g.group)) ? "  ⭐" : "";
      console.log(`✔ ${name.padEnd(16)} → ${vals.slice(0, 8).join(", ")}${vals.length > 8 ? " …" : ""}${flag}`);
      if (groups.some((g) => /active|passive/i.test(String(g.group)))) hits.push(name);
    } catch (e) {
      console.log(`✗ ${name.padEnd(16)} → ${e.message.replace(/\s+/g, " ").slice(0, 60)}`);
    }
  }

  console.log("");
  if (hits.length) {
    console.log(`✅ 含 active/passive 的字段：${hits.join(", ")} —— 这就是主动/被动的字段名`);
  } else {
    console.log("⚠️ 候选字段里没找到 active/passive。要么字段名不在这份候选里，");
    console.log("   要么主动/被动其实靠不同 event_name 或 XMP campaign 类型区分（Customer Form=留咨/被动）。");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
