// 探测 AIguild_active / AIguild_passive 到底出现在哪些事件、哪个属性下。
// 对一批代表性事件（前段广告入口 + 后段），按 source(profile) 完整分组，打印所有取值。
// 用法：node byteplus-probe-activepassive.mjs [天数]   默认 30
import { fetchEventDailyGrouped } from "./lib/byteplus.mjs";

const DAYS = Number(process.argv[2]) || 30;

// 覆盖漏斗前段到后段的代表事件（active/passive 是广告入口行为，重点看前段）
const EVENTS = [
  ["投广页曝光", "pwa_conv_lp_show"],
  ["投广页点击", "pwa_conv_lp_clickButton"],
  ["安装成功", "web_install_success"],
  ["谷歌登录页", "web_login_page_show"],
  ["名字页曝光", "pwa_conv_set_name_show"],
  ["IG授权", "pwa_ins_login_button_click"],
];

const isAP = (v) => /active|passive/i.test(String(v));

async function probe(name, type, loc) {
  const res = await fetchEventDailyGrouped({ eventName: name, lastDays: DAYS, groupBy: "source", propertyType: type, groupLocation: loc });
  return [...res.series].sort((a, b) => b.sum - a.sum);
}

async function main() {
  console.log(`探测 source 值（含 AIguild_active/passive），最近 ${DAYS} 天\n`);
  for (const [label, name] of EVENTS) {
    console.log(`\n===== ${label}  (${name}) =====`);
    // 先试用户属性(profile)，再试事件属性(event_param)
    for (const [type, loc, tag] of [["profile", "content", "用户属性"], ["event_param", "event", "事件属性"]]) {
      try {
        const groups = await probe(name, type, loc);
        if (groups.length === 1 && groups[0].group === "__all") { console.log(`  [${tag}] __all（不可分组）`); continue; }
        const total = groups.reduce((a, g) => a + g.sum, 0);
        const line = groups.map((g) => `${g.group}=${g.sum}`).join("  ");
        const apHit = groups.some((g) => isAP(g.group));
        console.log(`  [${tag}] ${line}   合计=${total}${apHit ? "   ⭐含active/passive" : ""}`);
      } catch (e) {
        console.log(`  [${tag}] ✗ ${e.message.replace(/\s+/g, " ").slice(0, 40)}`);
      }
    }
  }
  console.log("\n看哪一行带 ⭐ —— 那就是 AIguild_active/passive 真实存在的事件+属性。把整段贴回。");
}

main().catch((e) => { console.error("失败：", e.message); if (e.cause) console.error("底层：", e.cause); process.exit(1); });
