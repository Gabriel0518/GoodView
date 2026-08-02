# GoodView 只读数据 API

给**其他 AI / 外部程序**通过 HTTP 读取本项目 Postgres 数据的接口。三个端点，一个 token。

---

## 快速开始

```bash
BASE=https://<你的-GoodView-域名>
TOKEN=<DATA_API_TOKEN>

# 1. 先读自述文档（端点列表 + 口径警告 + 示例）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/data

# 2. 再读表结构
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/data/schema

# 3. 然后就能查了
curl -s -X POST $BASE/api/data/query \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT date, SUM(cost) FROM campaign_daily WHERE date > CURRENT_DATE - 7 GROUP BY date ORDER BY date"}'
```

**把上面三行直接给对方 AI 就够了**——`/api/data` 会自述能力、`/api/data/schema` 会给出每张表的口径说明，它能自己摸清怎么用。

---

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/data` | 自述文档：端点、鉴权、**口径警告**、示例 SQL |
| GET | `/api/data/schema` | 19 张表的字段/类型/约行数 + 每张表一句话口径说明 |
| POST | `/api/data/query` | 执行只读 SQL。body `{"sql":"...", "limit":1000}` |

查询返回：
```json
{ "ok": true, "columns": ["date","cost"], "rows": [...],
  "rowCount": 7, "truncated": false, "elapsedMs": 142 }
```

鉴权两种都行：`Authorization: Bearer <token>` 或 `?token=<token>`（后者给不能自定义 header 的调用方）。
**未配置 `DATA_API_TOKEN` 时接口整体返回 503**——默认拒绝，不会误部署成裸奔。

---

## 安全设计

三层防护，**真正的安全边界是第 2 层**：

| 层 | 机制 | 作用 |
|---|---|---|
| 1 | `validateSql()` 文本检查 | 拒绝多语句、非 SELECT/WITH 开头。**只为早点给出清晰报错，不承担安全职责**（正则总能被绕过） |
| 2 | **`BEGIN READ ONLY` 事务** | Postgres 内核拒绝一切写入和 DDL，**与 SQL 文本长什么样无关** ← 边界在这里 |
| 3 | 专用只读角色 `goodview_readonly` | 连权限都没有。即使第 2 层将来被改坏也写不进去 |

另有：语句超时 15 秒、返回行数上限 5000（超出 `truncated=true`）、SQL 长度上限 2 万字符。

### 为什么需要第 3 层

主连接身份是 `postgres` **超级用户**。只靠事务守卫，一旦有人误删那行 `BEGIN READ ONLY`，外部 SQL 就能拿超级用户权限跑任意语句。只读角色把这个风险从「代码正确性」降级成「权限配置」。

建角色：
```bash
node db/create-readonly-role.mjs      # 建角色 + 授权 + 打印连接串
node db/verify-readonly.mjs           # 验证：读通过，建表/插入/更新/删除/删表全被拒
```

`create-readonly-role.mjs` 做了 `ALTER DEFAULT PRIVILEGES`，**以后新建的表自动可读**，不用每加一张表手动 GRANT。

---

## 环境变量

```bash
DATA_API_TOKEN=gv_xxxxx              # 必填。不配则接口禁用
DATA_API_DATABASE_URL=postgresql://goodview_readonly:...@host/db   # 可选但强烈建议
```

不配 `DATA_API_DATABASE_URL` 时回退主 `DATABASE_URL` + READ ONLY 事务（仍然安全，只是少一层）。

Railway 上只需要给 **web 服务（GoodView）** 配这两个变量，`feishu-sync` 不需要。

---

## 口径说明为什么是这个接口的主体

外部 AI 不了解本项目的坑。只给数据不给口径，它会**自信地算出错误结论**——这比不给数据更糟。所以 `/api/data` 和 `/api/data/schema` 都会返回 `important_caveats`（8 条），每张表也带 `note`。

几条最容易踩的（完整列表见接口返回）：

- **时区错位**：花费按 `Asia/Shanghai`（广告账户日）、转化按 `America/Chicago`（德州本地日），差 13 小时。越靠近当下，「今天」的单价越虚高。
- **最新一天不完整**：北京时间白天查「今天」，德州那边往往还没开始 → 转化接近 0 而花费已过大半。判断趋势请用上一个完整日。
- **注册有两套口径**：`key_metric_daily.register` 是含回访的日 UV（偏高约 1.9 倍）；`dms_metric_daily.register` 是业务库建号、每人一次，才是「日新增」。
- **IG授权 ≠ IG绑定**：授权在前、绑定在后，授权→绑定长期只有 26~38%。
- **埋点断档**：`task_id` 2026-07-24 才上报，此前 `funnel_daily` 的 `task_ins_bind` 恒为 0，要用业务库。

改口径说明改 `app/lib/data-api.ts` 的 `CAVEATS` 和 `TABLE_NOTES` 两个常量。

---

## 测试

```bash
npm run dev                # 本地起在 7101
./test-data-api.sh         # 16 项：鉴权 / 文档 / schema / 正常查询 / 各类写操作必须被拒
BASE=https://<线上域名> ./test-data-api.sh   # 也可打线上
```

---

## ⚠️ 已知问题：其它接口没有鉴权

本 API 做得再严，隔壁门是敞开的也没意义。当前 `app/api/` 下**除 `af/push` 外全部无鉴权**，其中危险的写接口：

| 路由 | 风险 |
|---|---|
| `POST /api/refresh` | `spawn("node", ["pull-all.mjs"], {detached:true})`，无速率限制无并发锁 → 任何人可无限触发全量拉取，打爆 XMP/BytePlus 配额 |
| `POST/PUT/DELETE /api/events` | 改 `funnel_stage_meta` = **改全站指标口径**，且下次 cron 会按新定义重新取数 |
| `DELETE /api/dashboards`、`/api/dashboards/[id]/cards` | 任意删看板与卡片 |
| `POST /api/ai/suggest`、`/api/ai/interpret` | 消耗 Kimi API 额度 → 任何人可刷账单 |

**没有直接加 token 是有原因的**：这些接口是前端页面在浏览器里调的，加了 token 就把看板 UI 打断了。可选方案：

1. 给写操作加**同源校验**（`Origin`/`Referer` 必须是自己的域名）——改动最小，挡住外部直接调用
2. 给整个 web 服务加一层访问控制（Railway 前面挂 Cloudflare Access / Basic Auth），只有本 API 走 token 例外
3. 前端加简单登录态，写接口校验 session

这件事没做，因为它会改变现有 UI 的行为，需要你先定方向。
