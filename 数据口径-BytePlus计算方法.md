# GoodView 数据口径与计算方法（BytePlus / XMP）

> 本文档记录数据看板每个指标的**官方定义、取数接口、计算规则**，供开发在工具里修改看板计算逻辑时对照。
> 所有 BytePlus 口径均以官方报表 `dsl_content` 抽取为准，已用独立复算验证（见 `analyze-aigongui.mjs`）。
> 最后核对：2026-07，窗口 2026-06-23~07-07。

---

## 0. 一句话口径

- **成材 = `pwa_withdraw_audit_apply` 且 (`withdraw_amount = 25` **OR** `will_cashout_stage = CashoutStageFive`)**（第5笔提现任务）。
- **注册 = `pwa_conv_cash_ready_pop_show`**（0.5刀提现弹窗-注册完成，≈完成首笔0.5提现）。
- 所有人数指标 = **`event_users` 去重 · `all` 粒度 · US/Eastern · 排除测试用户**。
- **AI公会 = source ∈ {AIguild, AIguild_active, AIguild_passive}**（7/3 前 AIguild，7/3 起 active/passive）。
- 后台"主漏斗(留资/已注册/首笔提现)"是**自有后台 CRM**的数，**与 BytePlus 不同源、不强求对齐**。

---

## 1. 接口与鉴权

### 1.1 Host / 路径
- Host：`https://analytics.byteplusapi.com`
- 事件分析：`POST /datafinder/openapi/v1/analysis`（body = 查询 DSL）
- 取报表定义：`POST /datafinder/openapi/v1/{app_id}/reports/{report_id}`（空 body `{}`）
- `app_id = 653834`

### 1.2 鉴权（两段式 HMAC-SHA256，放 `Authorization` 头）
1. `prefix = ak-v1/{ak}/{ts}/{exp}`（ts=当前秒，exp=ts+300）
2. `signKey = HMAC_SHA256(sk, prefix)` → hex
3. `canonical = "HTTPMethod:POST\nCanonicalURI:{uri}\nCanonicalQueryString:\nCanonicalBody:{原始JSON body}"`
4. `signature = HMAC_SHA256(signKey, canonical)` → hex
5. 头值 = `prefix/signature`

> AK/SK 必须是 DataRangers OpenAPI 团队 key（自建 IAM key 报 invalid accesskey）。代码见 `lib/byteplus.mjs` 的 `authHeader / postAnalysis / getReport`。

### 1.3 报表 → 取数流程（关键）
报表接口返回的是**查询定义**（`data.dsls[0].dsl_content`），`data` 是空壳未计算。取数步骤：
1. `getReport(report_id)` → 拿 `dsl_content`
2. 改 `dsl_content.periods` 的日期（见 §3）
3. 把 `dsl_content` 丢给 `POST /analysis`（`postAnalysis`）→ 得计算结果

---

## 2. 三张官方报表

| 报表 | report_id | 用途 |
|---|---|---|
| PWA 转化率看板 | `7644454932824719925` | 注册 Q、任务2 P1、INS T1、投广页曝光 A、安装成功 H、名字页 K 等全漏斗 |
| 素人女成材看板 | `7648916887593550389` | 任务漏斗 任务1~5（**成材=任务5**） |
| 裂变成本(周) | `7651828365120258565` | 裂变总成本 / 裂变成材成本（算总投广金额 x 用） |

---

## 3. 时间窗与时区

- 报表锚 **US/Eastern**（不是上海）。XMP 锚美西（账户时区）。
- period 结构：`type:"past_range"`，`spans` 两元素（起、止）。两种编码都可用，统一用 **timestamp**：
  ```json
  "spans": [
    {"type":"timestamp","timestamp":"<起 秒>"},
    {"type":"timestamp","timestamp":"<止 秒>"}
  ]
  ```
- **ET 时间戳换算**（1 天 = 86400 秒）：
  - `START 00:00:00 ET`、`END 23:59:59 ET`
  - 基准：**2026-06-23 00:00 ET = 1782187200**；**2026-07-07 23:59:59 ET = 1783483199**
  - 任意日：以基准 ± 86400×天数 平移。

---

## 4. 计算规则（缺一不可，否则数不对）

1. **指标**：`event_indicator = "event_users"`（去重人数 UV）。
2. **粒度**：`periods[].granularity = "all"`（整段去重，结果 `data` 长度=1，取 `sum`）。
   - **不要**用 `day` 粒度再按天求和 —— 那是"人次"，会重复计、虚高。
   - `"total"` 不被支持（400），只能用 `"all"`。
3. **排除测试用户**（放 `content.profile_filters`，两条 AND）：
   ```json
   {"expression":{"logic":"and","expressions":[
     {"logic":"or","conditions":[{"property_type":"profile","property_name":"is_test","property_operation":"!=","property_values":["true"]}]},
     {"logic":"or","conditions":[{"property_type":"event_param","property_name":"isTest","property_operation":"!=","property_values":["true"]}]}
   ]}}
   ```
   （`is_test` 是用户属性 profile，`isTest` 是事件属性 event_param —— 两个都要排。）
4. **事件属性过滤格式**（放 query 的 `filters`）：**必须**用 `expression/logic/conditions` 包裹，字段是 **`property_values`**（不是 `values`），**值是数字**（`[25]` 不是 `["25"]`）：
   ```json
   "filters":[{"expression":{"logic":"and","expressions":[
     {"logic":"or","conditions":[{"property_type":"event_param","property_name":"withdraw_amount","property_operation":"=","property_values":[25]}]}
   ]}}]
   ```
   > ⚠️ 扁平写法 `{property_type,property_name,property_operation,values}` 会被**静默忽略**（过滤不生效、返回未过滤总数）。
   > 多值 = OR：`property_values:[4,5.5,7]` 表示 4/5.5/7 任一。
   > **跨属性 OR**（如成材 = wd=25 **或** stage=CashoutStageFive）：把两个条件放进**同一个 `or` 组的 `conditions`**：
   ```json
   "filters":[{"expression":{"logic":"and","expressions":[
     {"logic":"or","conditions":[
       {"property_type":"event_param","property_name":"withdraw_amount","property_operation":"=","property_values":[25]},
       {"property_type":"event_param","property_name":"will_cashout_stage","property_operation":"=","property_values":["CashoutStageFive"]}
     ]}
   ]}}]
   ```

---

## 5. 字段定义表（官方，从 dsl_content 抽取）

### 5.1 任务漏斗（成材报表 `7648916887593550389`）
全部 `event_name = pwa_withdraw_audit_apply` + `event_users`，按提现档位区分：

| 阶段 | show_label | 事件 | 过滤（**业务修正版，以此为准**） |
|---|---|---|---|
| 完成任务1 = **首提** | F | pwa_withdraw_audit_apply | `withdraw_amount = 0.5` |
| 完成任务2 | G | pwa_withdraw_audit_apply | `withdraw_amount ∈ {4, 5.5, 7}` |
| 完成任务3 | H | pwa_withdraw_audit_apply | `withdraw_amount ∈ {10, 20}` |
| 完成任务4 | I | pwa_withdraw_audit_apply | `withdraw_amount = 12` |
| **完成任务5 = 成材** | J | pwa_withdraw_audit_apply | **`withdraw_amount = 25` OR `will_cashout_stage = CashoutStageFive`** |

> ⚠️ **报表 `dsl_content` 里存的是旧档位**：任务2=`{4,7}`、任务3=`8`、任务5=`25`（无 CashoutStageFive）。**旧档位已过时，实际计算以上表"业务修正版"为准。** 落地实现见 `analyze-aigongui.mjs`（已按修正版）。
> `will_cashout_stage` 值是**字符串** `"CashoutStageFive"`；`withdraw_amount` 是**数字**。成材的 OR 放在同一个 `conditions` 数组里（见 §4.4）。

（该报表还含前段曝光：投广页曝光 `pwa_conv_lp_show`、投广页点击 `pwa_conv_lp_clickButton`、安装页曝光/点击、名字页曝光 `pwa_conv_set_name_show`，均无过滤。）

### 5.2 转化率报表 `7644454932824719925` 关键字段（对应 SOP 变量）

| SOP 变量 | 含义 | show_label | query_name |
|---|---|---|---|
| **Q** | 注册人数 | Q | 0.5刀提现弹窗-注册完成（`pwa_conv_cash_ready_pop_show`） |
| **P1** | 任务2人数 | P1 | 完成任务2 |
| **T1** | INS 人数 | T1 | Ins授权回调-授权成功 |
| **A** | 投广页曝光（漏斗首层） | A | 投广页曝光 |
| **H** | 安装成功 | H | 安装成功（`web_install_success`） |
| **K** | 名字页曝光 | K | 名字页曝光 |
| — | 绑定Ins任务完成 | S1 | 绑定Ins任务完成（`pwa_task_complete` + `task_id=110`） |

> INS 有两种口径：`T1 = Ins授权回调-授权成功`(SOP 用它)；`绑定Ins任务完成 = pwa_task_complete + task_id=110`。按需求选，别混。

---

## 6. source 维度与 AI公会

- `source` 是**用户属性**（`property_type:"profile", property_name:"source"`）。已知值：`fb`(Facebook) / `tt`(TikTok) / `bff` / `AIguild` / `AIguild_active` / `AIguild_passive`。
- **AI公会 = AIguild + AIguild_active + AIguild_passive**。
  - 7/3 前统一 `AIguild`；7/3 起（含 7/3）拆 `AIguild_active`(主动/直发短信) / `AIguild_passive`(被动/留咨)。
- **取 AI公会 数的两种做法**（等价）：
  - **分组**：`content.profile_groups_v2 = [{property_type:"profile",property_name:"source"}]`，结果按源拆，取 AIguild+active+passive 之和。
  - **过滤**：`profile_filters` 加一条 `source ∈ {AIguild,AIguild_active,AIguild_passive}`。
- ⚠️ **source 是"晚打标"**（登录/绑定后才写入用户属性）。所以：
  - **可信**：中后段事件（注册、任务1~5、绑定Ins）——用户此时已打标。
  - **不可信**：早期事件（投广页曝光/点击、安装页）——大量用户当时无 source，分组会严重少计（例：投广页曝光全量 34529，按 source 分组求和仅 729）。**早期漏斗别按 source 拆。**
- `content.page.limit` 默认 50 会截断小分组，**设为 1000**。

---

## 7. 花费（XMP）

- AI公会 广告系列：`AIguild_active ↔ 0630_web_text`，`AIguild_passive ↔ 0617_Customer Form_1`。
- SOP §6 的 XMP 账户拆分（周报口径）：`AI公会 = 账户 pwa-2026-02`；`FB = 除 pwa-2026-02 外所有含 pwa 的账户`。
- 取数：`fetchReport({startDate,endDate,dimension:["campaign_name"]或["account_name"],metrics:["cost"]})`（见 `lib/xmp.mjs`）。

### 成本公式（SOP §8）
- 投广金额 `x = FB + AI公会 + 裂变总成本`
- 注册成本 `= x / Q`；任务2成本 `= x / P1`；INS成本 `= x / T1`；成材成本 `= x / J`
- 投广PWA安装率 `= H / A`；投广注册成功率 `= Q / A`；到访注册成功率 `= Q / K`
- 单阶段"AI公会成本" = AI公会花费($771.05 = 0630+0617) ÷ 该阶段 AI公会 人数

---

## 8. 实测样例（2026-06-23~07-07，ET，去重，排除测试）

> ⚠️ 下列 **任务2 / 任务3 / 成材** 的数值是按**旧档位**（{4,7} / 8 / wd=25）算的，尚未按 §5.1 业务修正版（{4,5.5,7} / {10,20} / 25-or-CashoutStageFive）刷新。改档位后重跑 `analyze-aigongui.mjs` 更新此处。注册/首提/任务4 未受影响。

### 全量
- 投广页曝光 A = 34,529 · 注册 Q = 5,315 · 完成任务1(首提) = 4,468 · **成材(任务5) = 131**
- 安装成功 H = 5,804 · 名字页 K = 6,740 · INS T1 = 1,547
- 率：安装率 H/A=16.8% · 注册率 Q/A=15.4% · 到访注册率 Q/K=78.9%

### AI公会（AIguild+active+passive）
| 阶段 | AIguild | active | passive | **AI公会** | 单AI公会成本 |
|---|---|---|---|---|---|
| 注册 | 55 | 8 | 11 | **74** | $10.42 |
| 完成任务1·首提 | 50 | 8 | 11 | **69** | $11.17 |
| 完成任务2 | 3 | 2 | 1 | **6** | $128.51 |
| 完成任务3 | 2 | 1 | 0 | **3** | $257.02 |
| 完成任务4 | 1 | 0 | 0 | **1** | $771.05 |
| **完成任务5·成材** | 1 | 0 | 0 | **1** | $771.05 |

花费：active(0630) $307.51 · passive(0617) $463.54 · AI公会合计 $771.05。
单源成本参考：active 单注册 $307.51/8=$38.44；passive 单注册 $463.54/11=$42.14。

---

## 9. 代码参考

| 文件 | 作用 |
|---|---|
| `lib/byteplus.mjs` | `postAnalysis(dsl)` 跑查询；`getReport(id)` 取报表定义；`postPath(uri,body)` 通用 POST；`fetchEventDailyGrouped(...)` 分组取数（支持 `period` 覆盖、`rawFilters`） |
| `lib/xmp.mjs` | `fetchReport(...)` XMP 花费 |
| `analyze-aigongui.mjs` | **AI公会 官方口径独立计算器**（本文档 §4/§5 的落地实现，已验证 首提=69/成材=1） |
| `byteplus-report-probe.mjs` | 报表定义抽取 + source 分组重跑（排错/核对用） |

---

## 10. 修改看板计算方法时的检查清单

- [ ] 用 `event_users` + `all` 粒度（不是 day 求和）
- [ ] 加 is_test/isTest 排除
- [ ] 过滤用 `expression/logic/conditions` + `property_values`，值为数字
- [ ] 时区 US/Eastern，日期用 timestamp span
- [ ] 成材 = withdraw_amount=25 **OR** will_cashout_stage=CashoutStageFive；任务2={4,5.5,7}；任务3={10,20}；注册 = pwa_conv_cash_ready_pop_show
- [ ] AI公会 = 3 个 source 之和；早期曝光类**不要**按 source 拆
- [ ] `page.limit=1000` 防截断
- [ ] 花费与人数分属两套系统，按 date+campaign/source 对齐，别跨立方硬拼

---

## 11. 关键指标 × 地区（德州实验）—— 2026-07-30 新增

BytePlus 看板 **「PWA德州实验看板」** `dashboard_id=7668155095304897077`（7 张报表）。本项目落地的是其中
**「PWA 德州关键指标转化率看板」`report_id=7668160292471177733`** 的官方配置，逐字实现在 `lib/key-metrics.mjs`。

### 11.1 六个关键指标（官方「配置指标」）

| 标签 | 显示名 | event_name | 指标 | 事件过滤 |
|---|---|---|---|---|
| A | 投广页曝光 | `pwa_conv_lp_show` | `event_users` 总人数(UV) | — |
| B | 安装成功 | `web_install_success` | `event_users` UV | — |
| C | 用户注册 | `pwa_conv_cash_ready_pop_show` | `event_users` UV | — |
| D | 可分发用户 | `pwa_conv_live_start_click` | `event_users` UV | — |
| E | IG绑定用户 | `pwa_task_complete` | `event_users` UV | `task_id = 110`（数字） |
| F | 成材用户 | `pwa_withdraw_audit_apply` | **`events` 总次数(PV)** | `withdraw_amount = 25`（数字） |

⚠️ 与 §5/§10 的老口径两处**故意不同**，别顺手统一：

1. **成材是 PV(总次数)**，不是 UV；且**没有** `will_cashout_stage=CashoutStageFive` 的 OR 条件。
   实测 30 天全量：`25 OR CashoutStageFive · UV = 325`｜**官方 `25 · PV = 350`**｜`25 · UV = 305`。
   `funnel_stage_meta.chengcai` 仍是老口径 UV+OR（AI公会/PWA 的「成材人数」「成材单价」用它做分子/分母），
   两套并存、各自正确 —— 一个是"关键指标看板的成材次数"，一个是"成材人数"。
2. funnel 的阶段名沿用全漏斗命名（`cash_ready_show`=0.5刀提现弹窗-注册完成、`live_go`=Live页 Go Live、
   `task_ins_bind`=绑定Ins任务完成），官方关键指标叫「用户注册 / 可分发用户 / IG绑定用户」。同一事件、两套名字。

### 11.2 细分筛选（**不带就不准**）

官方 `profile_filters`（关键指标看板逐字）：

```
is_test (profile)      != ["true", ""]
isTest  (event_param)  != ["true"]
loc_province_id (profile) = "4736286"     ← 德克萨斯州
```

- 前两条 = 排除测试用户，`lib/byteplus.mjs` 的 `IS_TEST_EXPRS` 对所有查询强制加。实测带不带空串结果一致
  （7 天注册 2061 = 2061），保留空串只为与官方逐字一致。
- **省份属性 = `loc_province_id`（profile），德州 = `4736286`**。按它分组返回的是 URL 编码中文省名
  （`%E5%BE%B7%E5%85%8B%E8%90%A8%E6%96%AF%E5%B7%9E` = 德克萨斯州），**过滤要用数字 id**。
  `loc_province`（省名属性）不存在。

### 11.3 三个地区各存一行，别用减法

`REGION_EXPRS`（`lib/byteplus.mjs`）：`TX` = `loc_province_id = 4736286`；`nonTX` = `!= 4736286`（含省份未知）；
`all` = 不加省份条件。

⚠️ **TX + nonTX 略大于 all**（实测 7 天注册 376 + 1694 = 2070 vs 全量 2061，+0.4%）：`loc_province_id`
是按事件归因的用户属性，同一人窗口内在州内州外都有事件时两边各算一次。所以三个地区**各自独立查询、各存一行**，
仪表盘直接取「非德州」行，不要拿 `全量 − 德州` 推。

### 11.4 时区

官方德州看板锚 **America/Chicago**；本管道用项目默认 **Asia/Shanghai**（`config.mjs BYTEPLUS.timezone`），
与 XMP 花费同一天界，方便和花费同表对比。实测德州注册 7 天：上海 376 / 芝加哥 336，差额几乎全在"今天"那半天
（芝加哥当天才过了几小时）。要复核官方数字：`fetchEventDaily({..., timezone: "America/Chicago"})`。

### 11.5 落地

| 环节 | 位置 |
|---|---|
| 口径定义 | `lib/key-metrics.mjs`（`KEY_METRICS` / `REGIONS`） |
| 抓取 | `fetch-key-metrics.mjs`（6 指标 × 3 地区 = 18 请求，并发池；`npm run pull:keymetrics`），已接入 `pull-all.mjs` |
| 存储 | Postgres `key_metric_daily(date, metric_key, region, count)` |
| 飞书 | 表「关键指标日报」`tblYbprDnPbGfRLy`（一行 = 一天 × 一地区，6 指标横排 + 5 个比率） |

比率的分母：官方链路是 曝光→安装→注册→(可分发/IG/成材)，但**注册人数 > 安装成功人数**（很多人不装 PWA
直接在浏览器注册），按 注册/安装 会 >100% 误导 → 前两级以曝光为分母，后三级以注册为分母。
即便如此，**「可分发/注册」仍可能 >100%**：可分发是当天活跃人数（含往日注册的老用户），
和当天注册人数不是同一批人 —— 这是日切面比值，不是同期群转化率。

### 11.6 德州花费口径（XMP 无州级维度）

XMP 的 `geo` 维度**只到国家**（PWA 账户全部返回 `US`，2026-07-30 实测），拿不到州级花费。故「德州花费」
= **定向德州的广告系列**：`campaign_name ~* 'texas|德州|德克萨斯'`（`feishu-tables.mjs` 常量
`TX_CAMPAIGN_PATTERN`），账户范围取抓取配置里归属非「上架包」的账户，渠道用 `campaign_daily.channel`。
近 30 天命中 11 条系列、全用 "texas" 命名、无其它变体，**2026-07-21 才开投**（Facebook + TikTok，Google 无）。

⚠️ 德州**转化**（按用户属性 `loc_province_id` 精确切）与德州**花费**（按系列名切）**不是同一批人**：
全美投放的系列同样会带来德州用户（7/21 之前德州系列还没开，德州注册却一直有）。所以
「德州系列注册单价」偏低（分母含非德州系列带来的德州用户）；要估德州总成本，用
`PWA全部花费 × 德州注册占比%`。落地表：飞书「德州近30日统计」`tblrILGMDezTT9CG`（`txDailyTable()`）。

---

## 12. 自有后台业务库（DMS）—— 2026-07-31 新增

`admin-api-prod.sitin.ai/api/open/aliyun-dms/run`（Bearer token，body `{"sql":"..."}`，**只放行 SELECT**）。
库名 **`archat`**（实例上唯一业务库），839 张表，是 sitin / PWA 产品的后台。

### 12.1 接口坑（实测）

- 返回列名在 `data.columns`、值的键却是 `c0/c1/...`，要自己映射（`lib/dms.mjs` 的 `query()` 已做）。
- **SQL 出错时 `success` 仍是 `true`**，错误在 `data.error` → 不能只看 success。
- 别用 `day` 等保留字做列别名 → `syntax error at or near "day"`。
- `task_id` / `amount` 等列是 **varchar**，跟数字比会报 `operator does not exist: character varying = integer`
  → 字面量一律写字符串 `'110'` / `'25'`。
- 时间列是 `timestamp without time zone`、存 **UTC 裸时间**。按目标时区切日必须写
  `(ts AT TIME ZONE 'UTC') AT TIME ZONE '<目标时区>'`；**只写后半段是把裸时间当成目标时区，方向反了**
  （实测写反后 7/28 IG绑定=45，写对=58，正好等于 BytePlus）。

### 12.2 关键表与口径映射

| 看板指标 | 业务库来源 | 状态 |
|---|---|---|
| **IG绑定** | `user_common_task` `task_id='110' AND status='FINISHED'`（按 `update_at`） | ✅ 已切换 |
| **成材** | `user_withdraw_task` `amount='25'`（按 `create_at`，不筛 status） | ✅ 已切换 |
| **注册** | `userinfo` `app_name='3'`（按 `created_at`） | ✅ 已切换（见 12.6） |
| 可分发 | `pwa_distribution` | 未接 |
| 渠道来源 | `userinfo.user_source` | 取值同 BytePlus，覆盖率同样只有 ~70% |
| 投广页曝光 / 安装成功 | — | ❌ 纯前端埋点，库里没有 |
| 德州细分 | — | ❌ 数据质量不可用（见 12.4） |

**`app_name` 是数字枚举**，映射在 `app_meta_info`（romi=14 / luma=13 / doni=11 / kira=21,23 / mora=27 / gracechat=4 …）。
**`app_name='3'` = PWA 产品**（映射表里没登记，靠数据反推确认）：它是唯一存邮箱的 app（88.8%，其余全 0%），
且 IG绑定 与 BytePlus 逐日几乎完全一致。

### 12.3 对数结果（2026-07-31 校验，America/Chicago 日切）

```
IG绑定  DMS 34/29/25/43/58/64/63  vs BytePlus 34/28/25/43/58/62/63   ← 几乎逐日相同
成材    DMS 11/ 9/14/70/42/26/21  vs BytePlus  7/ 9/ 7/75/44/28/22   ← 同量级同走势
注册    DMS 133/150/154/179/219/270/267 vs BytePlus 312/302/294/296/322/334/306  ← 差 ~32%
```

注册差异的**真正原因见 12.6**（不是漏斗位置不同，是弹窗事件会重复触发）。

### 12.4 为什么德州拆分只能留在 BytePlus

- `user_geo_location` 覆盖率 99.9% 但**值是脏的**：`province` 最大一档是字面量 `'0'`（7/28 起 11682 行），
  城市名混进州名列（`Houston` 实际属德州 → 会漏算），运营商名进 `city`（`T-Mobile USA, Inc.`），
  还有中文城市（无锡市）。
- `userinfo.zip_code` 只有 **15.9%** 覆盖（美国邮编本可确定性映射到州，可惜数据太少）。
- → 德州/非德州仍由 BytePlus 的 `loc_province_id` 提供。

### 12.5 落地

`lib/dms.mjs`（客户端 + `dayExpr()` 时区转换）· `fetch-dms.mjs`（`npm run pull:dms`，已接进 `pull-all`）
→ Postgres `dms_metric_daily(date, metric_key, count)`（**无 region 列**，只有全量口径）。

飞书「关键指标日报」：**全量行**的 IG绑定/成材 用业务库，**德州/非德州行**仍用 BytePlus，
靠「IG/成材来源」列标明。副作用：这两个指标上 德州+非德州 与 全量 会对不齐（换源差），
要同源比较就看德州/非德州两行。DMS 缺数时自动回退 BytePlus（SQL 里 `COALESCE`）。


### 12.6 注册口径定案（2026-07-31 用户拍板）

**定义**：注册 = **0.5 刀提现弹窗曝光**（`pwa_conv_cash_ready_pop_show`）—— 用户确认以此为准。

**但日新增取值改用业务库**，因为这个事件**会对同一个人跨天重复触发**：

```
30 天(7/02~7/31, 芝加哥)  逐日 UV 求和 = 10603 人次
                          整段去重 UV  =  5598 人      ← 1.9 倍
                          业务库建号   =  5034 人      ← 与去重值差 10%
```

即 BytePlus 的日 UV 是「**当日看到弹窗的人数**」而非「当日新注册」；两者在「总共有谁注册了」上
是一致的（5598 vs 5034），只是日切方式不同。业务库的建号行天然每人一次，正是日新增。
（试过加官方的新用户条件 `user_is_new=1`(profile，值是**数字 1**)，7 天只剩 763，比业务库 1372
更严、不合用。）

⚠️ **`granularity:"all"` 必须带 `align_unit:"day"` + `skip_period:false` + `week_start:1`**，
否则 spans 被静默忽略、只返回最近一天多（踩过：以为去重值是 368，实际那是 1.3 天的数）。

**看板呈现**：「关键指标日报」的 **全量行** 注册/IG绑定/成材 用业务库（每人一次）；
**德州/非德州行** 仍是 BytePlus（业务库切不了地区，见 12.4）。两者**不同尺度**，
会出现「非德州 > 全量」——不是数据错。「核心指标来源」列标注 `业务库·日新增` / `BytePlus·含回访`。
**别拿地区行和全量行做减法**；要比德州 vs 非德州就只看那两行（同源可比）。
