# HANDOFF —— 交给 Claude CLI 继续开发

> 你（Claude CLI）接手这个项目的 v2 开发。与之前的助手不同，**你能直连第三方**（Railway/Postgres、XMP、BytePlus、npm、git、Railway CLI），所以**迁移、回补、装依赖、部署、验证都由你直接执行**，不用等用户代跑。

## 0. 你的环境与权限

- 工作目录：`/Users/gabriel/Developer/presence`
- **能直接做**：`node db/migrate.mjs`、`npm install`、`npm run pull` / `pull:backfill`、`npm run dev`、`git push`（origin=GoodView）、Railway CLI（`railway run/up/variables`，若已登录）。
- **密钥**：全在 `.env`（gitignore，不提交）。含 `DATABASE_URL`（Railway 公网 proxy 串）、XMP/BytePlus/Kimi。
- **验证**：起 `npm run dev` 连 Railway 库；用 tsc / reconcile / 直接查库。

## 1. 项目一句话 + 必读文档

Creator 接单平台的广告投放→转化数据看板。数据源：XMP（广告花费）、BytePlus DataRangers（PWA 漏斗事件）→ Postgres → Next.js 14。
**先读**（按序）：
1. `产品设计-v2.md` —— v2 自助看板搭建器的完整设计（已定稿）
2. `实现计划-v2.md` —— P1/P2/P3 分期，每期文件/schema/API/风险
3. `DEV-AGENTS.md` —— Subagent 分工与文件归属（Lead 调度，Data/Backend/Frontend/Verify）
4. `DEV-LOOP.md` —— 每切片走「开发→验证→提优化意见→再开发」，无 P0/P1 才算完
5. 项目记忆（`.claude` memory）里的 xmp/byteplus/项目 三条

## 2. 关键事实与坑（务必遵守）

- **IG授权 = 绑定Ins任务完成 = `pwa_task_complete` + `task_id=110`**（funnel stage `task_ins_bind`，约1981/30天），**不是** `pwa_ins_login_button_click`（按钮点击8438）。前端用 `IG_STAGE="task_ins_bind"`。
- **双立方体**：花费(campaign_daily: 日期×账户×系列×adset) 与 漏斗(funnel_daily: 日期×来源×阶段) **只在 日期 + 渠道↔来源 对齐**（fb↔facebook、tt↔tiktok；bff/AIguild/unknown 无花费；google 无来源）。系列×漏斗阶段无法连接（BytePlus 无 campaign_id）。搭建器只给能对齐的维度。
- **三类度量聚合**（查询引擎命门）：可加(花费/曝光/点击)=SUM；比值(CPM/CTR/CPC/转化率/单位成本)=从分量重算，永不加比值；人数=每日UV，跨日求和=「人次」非真去重（一次性事件≈真去重，重复事件高估），标注清楚。
- **成本失真**：XMP 花费是全 App 的，漏斗只 PWA → 默认成本口径失真。用**分组**把 PWA 账户/系列圈出来（P1.3 已建 ad_groups + `/admin/groups` 页 + `resolveGroup`）。用户手动指定 PWA 成员（10 个含 "pwa" 的账户是候选）。
- **XMP 每次请求限 90 天，但有长历史**（实测到 2025-07 有数据）→ `fetch-snapshot` 已用 `dateChunks` 自动分段；`pull:backfill=365`。BytePlus 漏斗 365 天一次拉取**未验证**，若报错需给漏斗也加分段。
- **数据永久保留**（永不 prune）；年视图=今日往前365天，钳制到有数据范围。
- **Railway 公网 proxy 偶发掐连接** → `app/lib/db.ts` 已加瞬时错误重试（`withRetry`）+ 每请求新建连接。上线用内网 DATABASE_URL 更稳。
- **Next 端口**：`start` 用 `-H 0.0.0.0 -p ${PORT:-7101}`（Railway 502 修复）。
- **不掩盖问题**：禁 `ignoreBuildErrors`/`@ts-ignore`/`eslint-disable`，遇错找根因。

## 3. 当前进度

- **v1 已上线**：GoodView 仓库 + Railway（web `goodview-production.up.railway.app` + Cron `pull-all` 每5分钟 + Postgres）。next 已升 14.2.35 修 CVE。
- **v2 P1.3 分组：已完成并验证** —— `ad_groups` 表、`app/lib/groups.ts`、`app/api/groups/**`、`app/admin/groups/page.tsx`。CRUD + 候选 + 连接重试都验过。
- **v2 P1.1 adset：进行中（只改了 schema）**：`db/schema.sql` 的 `campaign_daily` 已加 `adset_id/adset_name` + PK 改 `(date,account_id,campaign_id,adset_id)`。**尚未做**：见下 §4。

## 4. 立即要接着做的（完成 P1.1）

1. `db/migrate-adset.mjs`（新）：对**已有** campaign_daily 幂等 ALTER —— `ADD COLUMN IF NOT EXISTS adset_id/adset_name`，回填 '_'，`SET NOT NULL`，`DROP CONSTRAINT ..._pkey`，`ADD PRIMARY KEY (date,account_id,campaign_id,adset_id)`。
2. `fetch-snapshot.mjs`：`dim` 加 `adset_id, adset_name`；`CAMPAIGN_COLS` 加两列；transform 加 `adset_id: r.adset_id || '_'`、`adset_name`。
3. `app/lib/data.ts` `CampaignRow` + `db-queries.ts` `CAMPAIGNROWS_SQL`：加 adset 两列（v1 聚合按 SUM 不受影响）。
4. 跑：`node db/migrate-adset.mjs` → `npm run pull:backfill`（一年，adset 级，约上百万行、较久）→ 验证 adset 有值、v1 数值不变（`node reconcile.mjs`）。

## 5. 之后按计划推进（到 P3，走 Loop）

- **P1.2 事件 DB 化**：`funnel_stage_meta` 加 `enabled/source_split/indicator`；`fetch-funnel.mjs` 从 DB 读事件定义（不再 import `funnel-events.mjs`，后者降级为种子）。
- **P1.4 保留/窗口**：确认永不 prune；`db-queries` 窗口参数化（v2 视图接管）；验证 BytePlus 365 分段。
- **P2**（核心）：`/api/query` 查询引擎（三类聚合+跨立方 join+日/月/年 rollup+分组解析）、度量目录 `metrics.ts`、`dashboards`/`cards` 表+CRUD、引导式搭建器、拖拽栅格（`react-grid-layout`，需 `npm install`）、5 种图表、默认看板（近30日 PWA组 花费+触达 走势）、退役 v1（`Overview/FunnelView/DailyReport.tsx`+`compute.ts`）。
- **P3**：AI 解读+推荐（Kimi，OpenAI 兼容，`.env` 有 `KIMI_API_KEY`；model/base 待确认）、事件配置页（`/admin/events` CRUD funnel_stage_meta）。

**每切片走 DEV-LOOP**：开发 → 验证(tsc+preview+reconcile) → 提排序优化意见 → 采纳P0/P1再开发 → 无P0/P1退出。**并行用 Subagent + 文件归属权**（DEV-AGENTS）。任务用 TaskCreate/TaskUpdate 跟踪。

## 6. 常用命令

```bash
node db/migrate.mjs            # 建表/播种（幂等）
node db/migrate-adset.mjs      # P1.1 adset ALTER（待建）
npm run pull                   # 拉最近30天写库
npm run pull:backfill          # 回补一年（分段）
npm run dev                    # 本地起页面（连 Railway 库）
node reconcile.mjs             # 库 vs 旧口径对账
npx tsc --noEmit               # 类型检查
git add -A && git commit -m "..." && git push   # 同步 GoodView（触发 Railway 部署）
```

## 7. 收尾

到 P3 全部完成、每切片 Loop 退出条件满足，才停。中途每完成一个切片：更新任务看板 + 一句交付说明；把 P3/技术债记入计划文档。
