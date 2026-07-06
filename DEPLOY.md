# 部署运行手册（Postgres + Next.js 一体 + Railway）

## 架构

```
拉取(每5分钟) → Postgres → Next.js(API routes 查库 + 页面) → 浏览器
```

- 拉取脚本 `pull-all.mjs` → `fetch-snapshot.mjs`(XMP)+ `fetch-funnel.mjs`(BytePlus) → 写库(campaign_daily / ig_auth_daily / funnel_daily / funnel_stage_meta / pull_runs)。
- 前端 `page.tsx`(force-dynamic) 每请求从库组装 `Snapshot`/`Funnel`（`app/lib/db-queries.ts`），前端组件与 `compute.ts` 不变。

## 本地开发

```bash
npm install                      # 装 pg + @types/pg 等
cp .env.example .env             # 填 DATABASE_URL + XMP/BytePlus 密钥（本仓库已带本地 .env）
# 起一个本地 Postgres（任选）：
#   Postgres.app / brew services start postgresql / docker run -e POSTGRES_PASSWORD=… -p 5432:5432 postgres
#   然后建库：createdb presence，并把 DATABASE_URL 指向它
node db/migrate.mjs              # 建表 + 播种 47 阶段
npm run pull                     # 灌一次数据（约 2-3 分钟，受 XMP QPM 限制）
npm run dev                      # http://localhost:7101
# 可选后台定时拉取：PULL_INTERVAL_MIN=5 node daemon.mjs
```

对账（库 vs 旧 JSON，可选）：`node reconcile.mjs`（见该脚本）。

## Railway 上线（DB 已就绪）

> 数据库已建表+播种+灌数（本地对着 Railway 公网串跑过 migrate+pull）。所以只需部署 web + cron，它们连**内网** Postgres 即可。

1. **推代码到 GitHub**（密钥在 `.env`，已 gitignore，不会上传）：
   ```bash
   cd /Users/gabriel/Developer/presence
   git init && git add -A && git commit -m "db + backend migration"
   git branch -M main
   git remote add origin <你的GitHub仓库URL>
   git push -u origin main
   ```
2. **Railway → 该项目（已有 Postgres 的那个）→ New → GitHub Repo**，选这个仓库。Nixpacks 自动识别 Next.js（`npm run build` / `npm start`，`start` 已用 `$PORT`）。
3. **Web service → Variables**，加：
   - `DATABASE_URL` = 引用变量 `${{Postgres.DATABASE_URL}}`（Railway 内网串，免走公网 proxy）
   - `XMP_CLIENT_ID`、`XMP_CLIENT_SECRET`、`BYTEPLUS_AK`、`BYTEPLUS_SK`、`BYTEPLUS_APP_ID=653834`、`BYTEPLUS_IG_AUTH_EVENT=pwa_ins_login_button_click`
   - Web service → Settings → Networking → **Generate Domain**，得到公网 URL。
4. **定时拉取**：再建一个 service（同仓库）作为 Cron：
   - New → GitHub Repo（同一个）→ 这个服务 Settings：
     - **Start Command**：`node pull-all.mjs`
     - **Cron Schedule**：`*/5 * * * *`
   - Variables：和 web service 一样（DATABASE_URL 引用 + 6 个密钥）。
   - Cron 服务每 5 分钟跑一次 pull-all 写库，跑完退出（无常驻）。
5. 打开 web 的公网域名验证；等 Cron 跑一轮后，看 `pull_runs` 多一条、页面「更新于」时间前进、右上角出现「有新数据」。

## 数据保留与累积（180 天回补 + 每日合并）

- **库是累积的，不是固定 30 天**。拉取用「按日期删除+插入」：只替换本次覆盖的日期，更早历史原样保留。
- **一次性回补 180 天**（本地对着 Railway 库跑，约 20-30 分钟，受 XMP QPM 限）：
  ```bash
  npm run pull:backfill          # = node pull-all.mjs 180
  ```
  XMP 单次最多 90 天，脚本会**自动拆成 ≤90 天分段**（180 天 → 2 段）逐段拉取、逐段写库（某段失败不丢已写入的段）。分段可用 `XMP_MAX_DAYS` 调（默认 90）。
  > 若 BytePlus 漏斗侧在 180 天报错（其限制未知），告诉我，我把漏斗拉取也改成分段。
- **每日合并**：Cron 每 5 分钟跑 `node pull-all.mjs`（默认 30 天）→ 刷新最近 30 天（覆盖 XMP 归因回补），更早的 150 天累积不动。
- **展示范围**：`WINDOW_DAYS`（默认 180）控制看板从 `MAX(date)` 往回显示多少天。库里可存更多，这里限制显示。
- **注意载荷**：180 天的 campaignRows（约 10-15 万行）会一次性传给浏览器（当前是客户端聚合架构），首屏可能几秒。若嫌慢，下一步做「服务端按日期范围过滤」把载荷压小（本次未做）。
- **可选清理**：超长历史可周期 `DELETE FROM campaign_daily WHERE date < now()::date - 200`（funnel_daily / ig_auth_daily 同理）。

：`lib/db.mjs`/`app/lib/db.ts` 对非 localhost 默认开 `ssl:{rejectUnauthorized:false}`。Railway 内网 Postgres 支持 SSL，正常。若内网连接报 SSL 错，把连接串换成 `?sslmode=disable` 或在 db 层按 `.railway.internal` 关 SSL。
- **手动「立即刷新」按钮**：fire-and-forget（后台跑 pull-all 立即返回），靠前端轮询检测完成——不会 HTTP 超时。
- **retention**：`db-queries.ts` 按 `WINDOW_DAYS`（默认30）从 `MAX(date)` 回取窗口；更早历史留库但不展示。需清理可周期 `DELETE FROM campaign_daily WHERE date < now()::date - 60`。
- **增量拉取**（后续优化）：每次只拉最近 3 天可把 campaign 拉取压到秒级，绕过 XMP QPM——本次未做。
