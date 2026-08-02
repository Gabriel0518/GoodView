// 对外只读数据 API 的共享层：鉴权 + 只读执行 + schema 自省 + 口径说明。
//
// 设计约束（改之前先看）：
//   1) 连接身份是 postgres **超级用户** → 只在应用层拦 SQL 文本是不够的（正则总能被绕过）。
//      真正的保险是 **READ ONLY 事务**：Postgres 内核层面拒绝一切写操作和 DDL，与 SQL 长什么样无关。
//      若另配了 DATA_API_DATABASE_URL（专用只读角色），则再加一层——即使事务守卫有 bug 也写不进去。
//   2) 表很大（campaign_daily 27 万行、funnel_daily 13.7 万行）→ 必须有行数上限和语句超时，
//      否则一条 `SELECT *` 能把内存和响应都撑爆。
//   3) 消费方是**其他 AI**，它不了解本项目的口径坑（时区错位、含回访的注册、埋点断档…）。
//      所以 /api/data 和 /api/data/schema 会把 CAVEATS 一起吐出去——不给口径说明的数据接口
//      只会让外部 AI 得出错误结论，比不给数据更糟。
import { Client } from "pg";

const MAIN_URL = process.env.DATABASE_URL || "";
// 可选：专用只读角色的连接串。配了就用它，没配则回退主连接 + READ ONLY 事务。
const RO_URL = process.env.DATA_API_DATABASE_URL || MAIN_URL;
const TOKEN = process.env.DATA_API_TOKEN || "";

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;
const STATEMENT_TIMEOUT_MS = 15000;

const isLocal = /localhost|127\.0\.0\.1/.test(RO_URL);
const ssl = isLocal ? false : { rejectUnauthorized: false };

// —— 鉴权 ——
// 支持 Authorization: Bearer <token> 与 ?token=<token>（后者方便不能自定义 header 的调用方）。
// 未配置 DATA_API_TOKEN 时**一律拒绝**，避免误部署成裸奔接口。
export function checkAuth(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  if (!TOKEN) return { ok: false, status: 503, error: "服务端未配置 DATA_API_TOKEN，接口已禁用" };
  const h = req.headers.get("authorization") || "";
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  const qs = new URL(req.url).searchParams.get("token") || "";
  const given = bearer || qs;
  if (!given) return { ok: false, status: 401, error: "缺少凭证：Authorization: Bearer <token> 或 ?token=" };
  // 长度先比，避免不同长度时的早退；再逐字符累积异或做常数时间比较
  if (given.length !== TOKEN.length) return { ok: false, status: 401, error: "凭证无效" };
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= given.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, status: 401, error: "凭证无效" };
}

// —— SQL 形态检查（第三层，最外层的快速失败）——
// 真正的安全边界是 READ ONLY 事务，这里只做「早点给出清晰报错」，不承担安全职责。
export function validateSql(sql: string): string | null {
  const s = (sql || "").trim();
  if (!s) return "sql 不能为空";
  if (s.length > 20000) return "sql 过长（上限 20000 字符）";
  // 去掉字符串字面量和注释后再找分号，避免把 'a;b' 里的分号误判成多语句
  const stripped = s
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/;\s*\S/.test(stripped)) return "只允许单条语句（检测到多个分号分隔的语句）";
  if (!/^\s*(select|with)\b/i.test(stripped)) return "只允许 SELECT / WITH 开头的只读查询";
  return null;
}

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
};

// —— 只读执行 ——
// BEGIN READ ONLY 之后，任何 INSERT/UPDATE/DELETE/DDL 都会被 Postgres 直接拒绝
// （报 "cannot execute ... in a read-only transaction"），无需依赖 SQL 文本判断。
export async function runReadOnly(sql: string, limit: number): Promise<QueryResult> {
  const cap = Math.min(Math.max(1, limit || DEFAULT_LIMIT), MAX_LIMIT);
  const client = new Client({ connectionString: RO_URL, ssl, keepAlive: true });
  const t0 = Date.now();
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    // 多取一行用于判断是否被截断
    const res = await client.query(`SELECT * FROM (${sql}) AS _q LIMIT ${cap + 1}`);
    await client.query("COMMIT").catch(() => {});
    const truncated = res.rows.length > cap;
    const rows = truncated ? res.rows.slice(0, cap) : res.rows;
    return {
      columns: res.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// —— schema 自省 ——
export async function getSchema(): Promise<unknown> {
  const client = new Client({ connectionString: RO_URL, ssl, keepAlive: true });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const cols = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public'
        ORDER BY table_name, ordinal_position`,
    );
    const stats = await client.query<{ relname: string; n_live_tup: string }>(
      `SELECT relname, n_live_tup FROM pg_stat_user_tables`,
    );
    await client.query("COMMIT").catch(() => {});
    const approx = new Map(stats.rows.map((r) => [r.relname, Number(r.n_live_tup)]));
    const byTable = new Map<string, { name: string; approxRows: number; note?: string; columns: unknown[] }>();
    for (const c of cols.rows) {
      let t = byTable.get(c.table_name);
      if (!t) {
        t = { name: c.table_name, approxRows: approx.get(c.table_name) ?? 0, note: TABLE_NOTES[c.table_name], columns: [] };
        byTable.set(c.table_name, t);
      }
      t.columns.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES" });
    }
    return [...byTable.values()].sort((a, b) => b.approxRows - a.approxRows);
  } finally {
    await client.end().catch(() => {});
  }
}

// —— 每张表一句话说明（外部 AI 靠它判断该查哪张表）——
export const TABLE_NOTES: Record<string, string> = {
  campaign_daily: "广告投放日报（来自 XMP）。日期是【广告账户时区 Asia/Shanghai】的日。粒度 date×账户×系列×广告组。注意：抓取白名单只清理最近 30 天，更早的历史里混有其它产品的账户，按 campaign_name/account_name 含 'pwa'/'sitin' 过滤才是 PWA。",
  campaign_metric_daily: "扩展指标长表（EAV）。metric_key='conversion' 是媒体侧回传的转化数，上架包(SmartReply)的安装量用它。",
  funnel_daily: "转化漏斗日报（BytePlus 事件）。date×stage_key×source。**是日 UV，同一人跨天会重复计**，逐日求和≈去重人数的 1.9 倍。source 为 AIguild* 的是 AI公会流量，PWA 口径要排除。2026-07-20 前后时区口径有接缝（US/Eastern→Asia/Shanghai）。",
  funnel_stage_meta: "漏斗阶段定义（DB 为权威源）。enabled 控制是否抓取。",
  key_metric_daily: "官方关键指标 × 地区。date×metric_key×region，**时区为 America/Chicago（德州本地）**。region: TX(德州)/nonTX(非德州)/all(全量)。⚠️ TX+nonTX 略大于 all（省份是按事件归因的用户属性，跨州用户两边都算），不要用减法推。metric_key: lp_show/install_success/register/distributable/ig_bind/chengcai/ig_auth。chengcai 是 PV(总次数)，其余是 UV(人数)。",
  dms_metric_daily: "自有后台业务库口径的指标（真实业务记录，比埋点准），按 America/Chicago 日。**无地区维度**（业务库切不了德州）。metric_key: register(建号，已排除无邮箱无手机的空壳)/register_all(建号总数)/ig_bind/chengcai。",
  af_events: "AppsFlyer 原始事件，**只有上架包 SmartReply**(app_id='whisper.smart.reply')。event_time 是 timestamptz，转本地日只写一次 AT TIME ZONE。AF Push 从 2026-07-29 才开始收、不补历史。注册=af_login_success，IG绑定=af_complete_ins_task。",
  af_event_map: "AF 事件名 → 业务阶段的映射表。",
  ad_daily: "素材(ad)级投放数据，仅活跃 PWA 账户。",
  adgroup_daily_report: "广告组日报与优化建议（派生表）。",
  ad_groups: "广告分组（如「PWA AI公会」），members 是 jsonb 数组。",
  xmp_fetch_config: "抓取配置（飞书为权威、本表是镜像）。category=account/campaign 是抓取白名单，=metric 是抓哪些字段。group_name 是账户归属：PWA / AI公会 / 上架包。",
  aiguild_os_daily: "AI公会分端(安卓/iOS)转化。",
  ig_auth_daily: "IG授权日报（旧口径 pwa_ins_login_button_click，前端未使用，勿用于分析）。",
  retention_summary: "留存快照（来自 BytePlus 留存报表）。",
  pull_runs: "拉取任务日志，最新一条可判断数据新鲜度。",
  dashboards: "自助看板定义。",
  cards: "看板卡片定义。",
};

// —— 全局口径警告（放在 API 自述里，外部 AI 必读）——
export const CAVEATS: string[] = [
  "【时区错位·最重要】花费(campaign_daily)按广告账户日 Asia/Shanghai 切，转化(key_metric_daily/dms_metric_daily)按 America/Chicago 切，两者差 13 小时。所以「当天」的单价是近似值：越靠近当下，转化覆盖的时段越短、单价越虚高。跨多日汇总时误差基本抵消。",
  "【最新一天不完整】芝加哥比北京晚 13 小时。北京时间白天查「今天」，德州那边往往还没开始或刚开始 → 转化接近 0 而花费已过大半。判断趋势请用上一个完整日。",
  "【注册有两套口径】key_metric_daily.register 是 BytePlus 事件 pwa_conv_cash_ready_pop_show 的日 UV，含回访、偏高约 1.9 倍；dms_metric_daily.register 是业务库建号数、每人一次，是真正的「日新增」。做日新增分析用后者，做地区拆分只能用前者（业务库没有地区维度）。",
  "【IG 有两个概念】IG授权(ig_auth, 事件 pwa_earning_ins_task_page_two_click，SOP 口径)在前，IG绑定(ig_bind, task_id=110)在后，授权→绑定的转化率长期只有 26~38%，别把两者混为一谈。",
  "【埋点断档】task_id 这个事件参数在 2026-07-24 才开始上报，此前 BytePlus 无法按 task_id 区分任务 → 2026-07-24 之前的 IG绑定 必须用业务库 dms_metric_daily 或自有后台，不能用 funnel_daily 的 task_ins_bind（那段恒为 0）。",
  "【花费口径】PWA 口径的花费需要剔除两类：归属「上架包」的账户（SmartReply，转化走 AppsFlyer 不在 BytePlus）和 AI公会系列（有独立看板）。见 xmp_fetch_config.group_name 与 ad_groups。",
  "【德州花费只能按系列名切】XMP 没有州级维度（geo 只到国家），德州花费 = campaign_name 匹配 texas/德州/德克萨斯 的系列。而德州转化是按用户属性省份切的 —— 两者不是同一批人，全美投放的系列同样会带来德州用户，所以「德州单价」是低估值。",
  "【空壳账号】业务库偶发批量灌入「建了号但邮箱手机都没填」的行（2026-07-31 一天 571 个）。dms_metric_daily.register 已过滤，register_all 未过滤，两者差值即空壳数，可用于监控异常。",
];
