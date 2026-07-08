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
