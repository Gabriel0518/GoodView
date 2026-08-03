// 摸底：女端标识 + 收入表在哪
import { query } from "./lib/dms.mjs";

console.log("=== userinfo 全部列 ===");
const cols = await query(`SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='userinfo' ORDER BY ordinal_position`);
console.log(cols.map((r) => `${r.column_name}(${r.data_type})`).join("  "));

console.log("\n=== 疑似性别列的取值分布 ===");
const genderCols = cols.filter((c) => /gender|sex|female|male|role|side|identity|type/i.test(c.column_name));
for (const g of genderCols) {
  try {
    const d = await query(`SELECT ${g.column_name} v, count(*) n FROM userinfo WHERE app_name='3'
       GROUP BY 1 ORDER BY n DESC LIMIT 8`);
    console.log(`  ${g.column_name}: ` + d.map((r) => `${r.v}=${r.n}`).join("  "));
  } catch (e) { console.log(`  ${g.column_name}: 查询失败 ${e.message.slice(0, 60)}`); }
}

console.log("\n=== 疑似收入相关表 ===");
const t = await query(`SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND (
     table_name ~* 'income|earn|revenue|reward|balance|coin|wallet|settle|bill|profit|salary|payout'
     OR table_name ~* 'withdraw|order|payment|trans')
   ORDER BY table_name`);
console.log(t.map((r) => r.table_name).join("\n"));
