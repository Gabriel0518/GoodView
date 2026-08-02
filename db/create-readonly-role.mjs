// 建一个专用只读角色给对外数据 API 用（第二层保险）。
// 主连接是 postgres 超级用户——即使 READ ONLY 事务守卫将来被改坏，用超级用户跑外部 SQL 仍然危险。
// 这个角色连写权限都没有，是权限层面的兜底。
//
// 用法：node db/create-readonly-role.mjs [密码]   （不传则自动生成）
// 跑完把打印出的 DATA_API_DATABASE_URL 填进 .env 和 Railway。
import crypto from "node:crypto";
import { query, end } from "../lib/db.mjs";
import { DATABASE_URL } from "../config.mjs";

const ROLE = "goodview_readonly";
const pass = process.argv[2] || crypto.randomBytes(18).toString("base64url");

const { rows: cur } = await query("SELECT current_database() AS db, current_user AS u");
const db = cur[0].db;
console.log(`目标库 ${db}，当前身份 ${cur[0].u}`);

const { rows: exists } = await query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
if (exists.length) {
  await query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${pass.replace(/'/g, "''")}'`);
  console.log(`角色 ${ROLE} 已存在 → 已重置密码`);
} else {
  await query(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${pass.replace(/'/g, "''")}'`);
  console.log(`已创建角色 ${ROLE}`);
}

// 只给连接 + 读 public schema 的权限；显式收回建表权
await query(`GRANT CONNECT ON DATABASE ${db} TO ${ROLE}`);
await query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
await query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
// 以后新建的表也自动可读（否则每加一张表就要手动 GRANT）
await query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`);
await query(`REVOKE CREATE ON SCHEMA public FROM ${ROLE}`);
console.log("已授予 CONNECT / USAGE / SELECT（含未来新表），并收回 CREATE");

// 拼出连接串：把主 URL 的用户名密码换成只读角色
const u = new URL(DATABASE_URL);
u.username = ROLE;
u.password = pass;
console.log(`\n把这一行填进 .env 与 Railway（feishu-sync 不需要，只有 web 服务要）：`);
console.log(`DATA_API_DATABASE_URL=${u.toString()}`);
console.log(`\n验证：应当报错 "permission denied"`);
console.log(`  psql "${u.toString()}" -c "CREATE TABLE t(x int)"`);

await end();
