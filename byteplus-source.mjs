// 探查 IG授权事件的 source 维度：把「事件属性/用户属性 × 放置层级」几种组合全跑一遍，
// 每种都打印实际分组值，用来定位 AIguild_active/passive 到底在哪套属性下。
// 用法：node byteplus-source.mjs [天数]   默认 30
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const DAYS = Number(process.argv[2]) || 30;
const WANT = ["AIguild_active", "AIguild_passive", "AIguild"];

const STRATEGIES = [
  { label: "事件属性 source", groupLocation: "event", propertyType: "event" },
  { label: "用户属性 source", groupLocation: "content", propertyType: "profile" },
  { label: "事件属性(content层)", groupLocation: "content", propertyType: "event" },
  { label: "用户属性(event层)", groupLocation: "event", propertyType: "profile" },
];

async function tryStrategy(st) {
  const res = await fetchEventDailyGrouped({ eventName: BYTEPLUS.igAuthEvent, lastDays: DAYS, groupBy: "source", ...st });
  return res;
}

async function main() {
  console.log(`IG授权事件「${BYTEPLUS.igAuthEvent}」最近 ${DAYS} 天 —— 探查 source 各种分组方式\n`);

  const wins = [];
  for (const st of STRATEGIES) {
    process.stdout.write(`【${st.label}】${JSON.stringify({ loc: st.groupLocation, type: st.propertyType })}\n`);
    try {
      const res = await tryStrategy(st);
      const groups = [...res.series].sort((a, b) => b.sum - a.sum);
      if (groups.length === 1 && groups[0].group === "__all") {
        console.log("  → 只返回 __all（未拆开）\n");
        continue;
      }
      console.log("  → 分组值：");
      for (const g of groups) console.log(`      ${String(g.group).padEnd(22)} ${g.sum}`);
      const hasWant = groups.some((g) => WANT.includes(g.group));
      if (hasWant) console.log("  ✅ 含你要的 active/passive/AIguild 值");
      wins.push({ st, res });
      console.log("");
    } catch (e) {
      console.log(`  ✗ ${e.message}\n`);
    }
  }

  // 若某套里出现了 active/passive，按天列出来
  const target = wins.find((w) => w.res.series.some((s) => s.group === "AIguild_active" || s.group === "AIguild_passive"));
  if (target) {
    console.log(`==== 命中「${target.st.label}」，按天列出 active/passive/AIguild ====`);
    const pick = WANT.map((w) => target.res.series.find((s) => s.group === w)).filter(Boolean);
    target.res.dates.forEach((d, i) => {
      console.log(`  ${d}  ` + pick.map((s) => `${s.group}=${s.data[i] ?? 0}`).join("  "));
    });
  } else {
    console.log("提示：没有任何一套 source 分组里出现 active/passive。");
    console.log("可能 active/passive 不是 source 的值，而是另一个属性名。把上面各套的分组值告诉埋点/开发确认字段。");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
