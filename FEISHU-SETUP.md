# 飞书多维表格同步 · 部署指引

把 Postgres 里的广告转化数据**单向镜像**到飞书多维表格（Base），你在飞书里直接搭仪表盘。
Postgres 仍是权威库、保全量历史；飞书只是给仪表盘用的镜像。

```
XMP / BytePlus ──(fetch-*.mjs, 不变)──▶ Postgres ──(sync-to-feishu.mjs)──▶ 飞书多维表格 ──▶ 飞书仪表盘
```

---

## 一、创建飞书自建应用（拿 App ID / App Secret）

> 定时同步跑在 Railway 上，必须用**自建应用**的凭证（tenant_access_token），不能用扫码登录。

1. 打开飞书开放平台 <https://open.feishu.cn/app> →「创建企业自建应用」，填名称（如 `广告看板同步`）。
2. 进入应用 →「凭证与基础信息」，记下 **App ID** 和 **App Secret**。
3. 「权限管理」里开通以下权限（搜索权限码添加）：
   - `bitable:app`（多维表格读写）—— 建表 / 读写记录必需。
   - `base:app:create` 或 `drive:drive`（云文档）—— 若要用脚本**新建 Base** 才需要；如果你在飞书里手动建 Base，可不加。
4. 「版本管理与发布」→ 创建版本并**发布**（企业内自建应用发布后权限才生效；如需管理员审批，走审批）。

## 二、准备目标 Base（拿 app_token）

> **✅ 已用飞书 CLI 建好，可跳过本节。** Base + 5 张表已创建在 `赵鹏 / presence.feishu.cn`：
> - `base_token`（= `FEISHU_APP_TOKEN`）：`Io0qbs1YHadG61sGrEEcUs7enTg`
> - 打开：<https://presence.feishu.cn/base/Io0qbs1YHadG61sGrEEcUs7enTg>
> - 表：广告投放日报 `tblCEEd7Fy43fxCU` · 转化漏斗日报 `tblnTg4Zdrvm1lKr` · IG授权日报 `tblyLE3X0Gi1KJpk` · 漏斗阶段定义 `tblLKG3sN38n34EN` · 广告分组 `tblNE41jaDkZr42Q`
>
> **⚠️ 关键**：该 Base 归属**用户「赵鹏」**。定时同步用**自建应用的 tenant_access_token** 写入，必须先把这个 Base **共享给你的自建应用**（多维表格右上「…」→ 添加协作者 → 选你的应用 → 可编辑），否则报无权限。
> `npm run feishu:init` 此时会检测到 5 张表已存在、直接跳过（幂等）；仅在你另起一个空 Base 时才需要它建表。

如需从零手动建（参考）：

**A. 手动建**
1. 飞书里新建一个「多维表格」，命名如 `广告转化看板`。
2. 打开它，浏览器地址形如 `https://xxx.feishu.cn/base/【app_token】?table=...`，中间那段就是 **app_token**。
3. 把这个多维表格**共享给你的自建应用**（或建在应用有编辑权限的文件夹里），否则应用无权写入。

**B. 脚本建 / CLI 建**：用 `lark-cli base +base-create`（本项目 Base 即此法所建），或应用有 `base:app:create` 权限时后续加建 Base 脚本。

## 三、填写环境变量

本地 `.env`（云端在 Railway 面板设同名变量）：

```bash
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_APP_TOKEN=xxxxxxxx          # 第二步拿到的 app_token
FEISHU_SYNC_DAYS=30               # 只镜像最近 N 天（Postgres 保全量）。单表 2 万行上限，30 天约 7k，安全
FEISHU_CAMPAIGN_GRAIN=campaign    # campaign(按系列, 行少, 默认) | adset(含广告组明细, 行多)
```

> 不填 `FEISHU_APP_TOKEN` 时，`pull-all` 会**跳过**飞书同步，只写 Postgres——安全的默认。

## 四、建表 + 首次同步

```bash
npm run feishu:init     # 幂等建表：缺哪张建哪张，已存在跳过
npm run feishu:sync     # 从 Postgres 灌最近 FEISHU_SYNC_DAYS 天到飞书（全量替换）
# 临时换窗口：node sync-to-feishu.mjs 15
```

建成的表（字段见 `feishu-tables.mjs`）：

| 表名 | 内容 | 同步方式 |
|---|---|---|
| 广告投放日报 | 日×账户×系列(×广告组) 花费/曝光/点击（过滤全 0 行） | 全量替换·近 N 天 |
| 转化漏斗日报 | 日×来源×阶段 人数（过滤 0 人数行） | 全量替换·近 N 天 |
| IG授权日报 | 日 IG 授权人数 | 全量替换·近 N 天 |
| 漏斗阶段定义 | 47 阶段元数据（顺序/事件名/开关） | 全量替换·全部 |
| 广告分组 | 账户/系列编组 | 全量替换·全部 |

## 五、Railway Cron（已部署）

已在 Railway 项目 `thorough-acceptance` / `production` 建好一个 **`feishu-sync`** 服务，自动**拉取 + 同步**一条龙：

| 项 | 值 |
|---|---|
| 源 | 同 GoodView 的 repo `Gabriel0518/GoodView`（分支 `main`）|
| 构建命令 | `npm install`（不跑 next build，纯拉数脚本）|
| 启动命令 | `node pull-all.mjs`（拉 XMP+BytePlus 写 Postgres → 自动接飞书同步）|
| Cron | `23,53 * * * *`（**每 30 分钟**）|
| 重启策略 | `NEVER`（cron 跑完即退出，不常驻）|
| 变量 | `DATABASE_URL=${{Postgres.DATABASE_URL}}` + XMP/BYTEPLUS/FEISHU_* 全套 |

改代码后 `git push` 到 `main` → GoodView 和 feishu-sync 都会重新构建。改频率：改该服务的 `deploy.cronSchedule`。

> 说明：这是「拉取+同步」合一的服务。飞书同步是全量替换（约 1.3 万行删+灌），30 分钟一轮完全够。若想更省接口调用，可把 cron 调稀（如每小时 `23 * * * *`）。GoodView（看板 web）不做 cron，只提供页面。

---

## 六、口径与注意事项

- **行数上限（本项目 2 万/表，硬限）**：`广告投放日报`默认**按系列粒度**且**过滤全 0 行**，近 30 天约 7k 行、留足余量。要广告组明细改 `FEISHU_CAMPAIGN_GRAIN=adset`（行数大增，需相应调小 `FEISHU_SYNC_DAYS`）。放大窗口前先估行数，别撞 2 万。
- **全量替换 + 最新在前**：每次同步先清空整表再按**日期倒序**灌入 → 飞书表恒等于 Postgres 近 N 天，无历史残留/无重复；万一中途超限或中断，保住的是**最近**的数据。
- **零值过滤**：花费/曝光/点击全 0 的投放行、人数为 0 的漏斗行不镜像（对聚合无影响，纯降噪降量）。
- **人数口径**：漏斗人数是**日去重人数**；飞书仪表盘里跨日求和 = **人次**（非周期真去重）。一次性事件（首提/成材）≈真去重，重复性事件（曝光/登录）会高估——与现有看板口径一致（详见 `数据口径-BytePlus计算方法.md`）。
- **单选字段**：渠道/来源是单选，写入新值时飞书自动补选项。
- **失败隔离**：同步单表失败不影响其它表，也不影响 Postgres。

## 七、常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `缺少 FEISHU_APP_ID / FEISHU_APP_SECRET` | `.env` 没填或没被加载（注意别把变量注释掉） |
| 飞书鉴权失败 99991xxx | App ID/Secret 错，或应用未发布 |
| 建表/写入 `NOTPERMISSION` / 无权限 | 应用没开 `bitable:app`，或没把该 Base 共享给应用 |
| `找不到表「…」` | 先 `npm run feishu:init` |
| `1254103 RecordExceedLimit` | 超单表 2 万行上限 → 调小 `FEISHU_SYNC_DAYS` 或用系列粒度 |
| `1254607 Data not ready` | 飞书瞬时忙（大批量删后立刻写）→ 已内置退避重试，通常自愈 |
