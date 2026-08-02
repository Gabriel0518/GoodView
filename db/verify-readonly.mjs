// 验证只读角色确实写不进去（第二层保险是否真的生效）
import pg from "pg";
process.loadEnvFile();

const url = process.env.DATA_API_DATABASE_URL;
if (!url) { console.error("未配置 DATA_API_DATABASE_URL"); process.exit(1); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const who = await c.query("SELECT current_user u, current_database() db");
console.log(`连接身份 ${who.rows[0].u} @ ${who.rows[0].db}`);

const cases = [
  ["读表", "SELECT count(*) FROM campaign_daily"],
  ["建表", "CREATE TABLE _probe_should_fail (x int)"],
  ["插入", "INSERT INTO funnel_daily(date,stage_key,source,count) VALUES ('2020-01-01','x','y',1)"],
  ["更新", "UPDATE funnel_stage_meta SET label='hacked' WHERE stage_key='lp_show'"],
  ["删除", "DELETE FROM pull_runs WHERE id > 0"],
  ["删表", "DROP TABLE campaign_daily"],
];
for (const [name, sql] of cases) {
  try {
    const r = await c.query(sql);
    console.log(`  ${name.padEnd(4)} ✅ 成功 ${name === "读表" ? "(" + r.rows[0].count + " 行)" : "← ⚠️ 不该成功！"}`);
  } catch (e) {
    console.log(`  ${name.padEnd(4)} 🔒 被拒：${String(e.message).slice(0, 60)}`);
  }
}
await c.end();
