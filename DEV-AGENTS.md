# v2 开发 —— Subagent 分工与同步开发文档

> 目的：把 v2（数据层 + 查询引擎 + 搭建器 + AI）的开发拆给多个 Subagent 并行/接力推进，用**文件归属权**避免互相踩踏、用**契约**保持同步。配套《实现计划-v2.md》《DEV-LOOP.md》。

## 1. 原则

1. **Lead 统一调度**：只有 Lead（主对话）能拆任务、分配、集成、做最终决策。Subagent 不自行扩范围。
2. **文件归属权**：每个 Agent 只改自己归属的文件；跨界改动必须回 Lead 协调。
3. **契约先行**：三个"接口契约"（DB schema、`/api/query` 请求/响应、`app/lib/data.ts` 类型）由 Lead 拍定后冻结，各 Agent 依契约独立开发。契约变更走 Lead。
4. **并行用 worktree 隔离**：需要同时改文件的 Agent 用 `isolation: worktree` 各自开分支，Lead 串行集成，避免冲突。
5. **任务看板**：用 TaskCreate/TaskUpdate 维护任务，状态透明（pending/in_progress/completed + blockedBy 依赖）。
6. **验证不可跳过**：任何 Agent 交付前，走《DEV-LOOP.md》的验证阶段。

## 2. Agent 角色与职责

| 角色 | 职责 | 归属文件 | 能否改代码 |
|---|---|---|---|
| **Lead**（主对话） | 拆任务、定契约、调度、集成、最终决策 | `app/lib/data.ts`(类型契约)、`db/schema.sql`(schema 契约)、计划/文档、任务看板 | 集成层 |
| **Data Agent** | 数据层：schema、拉取、迁移、回补、分组解析 | `db/**`、`lib/*.mjs`、`fetch-*.mjs`、`pull-all.mjs`、`config.mjs`、`funnel-events.mjs`(种子) | ✅ |
| **Backend Agent** | 查询引擎、度量目录、分组、API | `app/lib/query-engine.ts`、`app/lib/metrics.ts`、`app/lib/groups.ts`、`app/lib/db.ts`、`app/lib/db-queries.ts`、`app/api/**` | ✅ |
| **Frontend Agent** | 搭建器、看板、图表、拖拽栅格、管理页 | `app/components/**`、`app/page.tsx`、`app/dashboard/**`、`app/admin/**`、`app/lib/hooks.ts`、`app/lib/util.ts`、`app/globals.css`、`tailwind.config.ts` | ✅ |
| **Verify Agent**（Audit） | 验证、对账、场景走查、**提优化意见**（不改代码） | 无（只出报告，可运行 `reconcile.mjs`/`audit-*.mjs`/preview） | ❌ |

> P3 增 **AI Agent**：`app/lib/kimi.ts`、`app/api/ai/**` + AI 相关组件。

## 3. 同步机制（三个冻结契约）

1. **DB schema**（`db/schema.sql`）：表结构 = Data ↔ Backend 的契约。Data 建表，Backend 依表写查询。
2. **查询 API**（`POST /api/query` 的请求/响应 JSON）：Backend ↔ Frontend 的契约。先定形状，前端可用 mock 先搭 UI。
3. **TS 类型**（`app/lib/data.ts` + `app/lib/metrics.ts` 的度量/维度定义）：全局共享，Lead 维护。

契约冻结后，三个 Agent 可**并行开发**：Data 建库+回补、Backend 写引擎、Frontend 用 mock 搭界面，最后 Lead 集成联调。

## 4. 任务拆解（按《实现计划-v2.md》分期）

### P1 数据地基
- `P1.1` Data Agent：campaign_daily 加 adset + 拉取加维度 + 全年回补
- `P1.2` Data Agent：事件定义 DB 化 + fetch-funnel 读 DB
- `P1.3` Backend+Frontend：ad_groups 表(Data 建) + 解析(Backend) + 组管理页(Frontend)
- `P1.4` Data Agent：去窗口上限 + 回补脚本 + BytePlus 365 分段验证

### P2 展示层
- `P2.1` Backend：查询引擎 + `/api/query`（**先冻结契约**）
- `P2.2` Lead+Backend：度量目录 `metrics.ts`
- `P2.3` Backend：dashboards/cards 表 + CRUD API
- `P2.4~2.7` Frontend：搭建器、看板页、拖拽栅格、图表、默认看板、退役 v1

### P3 智能层
- `P3.1/3.2` AI Agent：Kimi 解读 + 推荐
- `P3.3` Frontend：事件配置页

## 5. 冲突规避与集成

- **一个文件同一时间只由一个 Agent 改**；需并行改同一文件 → 拆函数或 Lead 串行。
- **并行任务用 worktree**，Lead 逐个 review + 合并。
- **每个集成点**：Lead 跑一次全量验证（tsc + preview + reconcile），过了才进下一批。
- **依赖用 blockedBy 标注**：如 P2.4 前端 blockedBy P2.1 契约冻结（非实现完成——有 mock 即可并行）。

## 6. 每个 Agent 的交付清单

- 改了哪些文件（在归属权内）
- 自测结果（tsc / 语法 / 相关单测）
- 与契约的一致性说明
- 遗留问题 / 给 Verify Agent 的验证点
