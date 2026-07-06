// 暴力探测：groupBy="source" 时，哪个 property_type token 能拆出 active/passive。
// UI 已证实 source 可取 AIguild_active/passive，但「用户属性(profile)」只给 fb/bff/tt/AIguild，
// 说明 active/passive 在「事件属性」上，需要找到正确的 property_type token。
// 用法：node byteplus-token-probe.mjs [天数]   默认 30
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";
import { BYTEPLUS } from "./config.mjs";

const DAYS = Number(process.argv[2]) || 30;

// 候选属性类型 token（profile 已知=用户属性；找事件属性的正确 token）
const TOKENS = ["event", "user", "custom", "custom_event", "item", "index", "public", "params", "event_param", "profile"];
const LOCS = ["content", "event"];

async function main() {
  console.log(`groupBy="source"，暴力试 property_type token（最近 ${DAYS} 天）\n`);
  let found = null;

  for (const propertyType of TOKENS) {
    for (const groupLocation of LOCS) {
      const tag = `${propertyType} @${groupLocation}`;
      try {
        const res = await fetchEventDailyGrouped({
          eventName: BYTEPLUS.igAuthEvent, lastDays: DAYS, groupBy: "source", propertyType, groupLocation,
        });
        const groups = [...res.series].sort((a, b) => b.sum - a.sum);
        if (groups.length === 1 && groups[0].group === "__all") {
          console.log(`  ${tag.padEnd(24)} → __all`);
          continue;
        }
        const vals = groups.map((g) => `${g.group}(${g.sum})`);
        const hasAP = groups.some((g) => /active|passive/i.test(String(g.group)));
        console.log(`✔ ${tag.padEnd(24)} → ${vals.slice(0, 10).join(", ")}${hasAP ? "   ⭐ 含 active/passive" : ""}`);
        if (hasAP && !found) found = { propertyType, groupLocation, res };
      } catch (e) {
        console.log(`✗ ${tag.padEnd(24)} → ${e.message.replace(/\s+/g, " ").slice(0, 50)}`);
      }
    }
  }

  console.log("");
  if (found) {
    console.log(`✅ 正确方式：property_type="${found.propertyType}", groupLocation="${found.groupLocation}"`);
    const want = ["AIguild_active", "AIguild_passive", "AIguild", "Alguild_active", "Alguild_passive", "Alguild"];
    console.log("\n按天（含 active/passive 的值）：");
    const pick = found.res.series.filter((s) => want.includes(s.group));
    found.res.dates.forEach((d, i) => {
      console.log(`  ${d}  ` + pick.map((s) => `${s.group}=${s.data[i] ?? 0}`).join("  "));
    });
  } else {
    console.log("⚠️ 所有 token 都没拆出 active/passive。把上面每行结果贴我，我再想办法（可能要改用 filter 精确匹配 source=AIguild_active）。");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  if (e.cause) console.error("底层原因：", e.cause);
  process.exit(1);
});
