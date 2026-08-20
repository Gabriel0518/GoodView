-- 广告转化看板 —— Postgres schema（幂等，可重复执行）
-- 由 db/migrate.mjs 应用。所有 date 用裸 date（业务日标签），不用 timestamptz。
-- 不存派生率(cpm/ctr/cpc/cost_per_ig_auth)——全部在 app/lib/db-queries.ts 的组装查询里算。

-- ========== campaign_daily：date × account × campaign × adset 广告花费（来自 XMP）==========
CREATE TABLE IF NOT EXISTS campaign_daily (
  date          date          NOT NULL,
  account_id    text          NOT NULL,
  account_name  text          NOT NULL,
  channel       text          NOT NULL,            -- XMP module: facebook / tiktok / google
  campaign_id   text          NOT NULL,
  campaign_name text          NOT NULL,
  adset_id      text          NOT NULL DEFAULT '_', -- 广告组（Meta adset）；无则占位 '_'
  adset_name    text          NOT NULL DEFAULT '_',
  cost          numeric(18,4) NOT NULL DEFAULT 0,  -- 保 XMP 4 位小数，避免求和浮点漂移
  impression    bigint        NOT NULL DEFAULT 0,
  click         bigint        NOT NULL DEFAULT 0,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, account_id, campaign_id, adset_id)
);
CREATE INDEX IF NOT EXISTS campaign_daily_date_idx         ON campaign_daily (date);
CREATE INDEX IF NOT EXISTS campaign_daily_date_channel_idx ON campaign_daily (date, channel);

-- ========== ig_auth_daily：date -> IG授权去重人数（来自 BytePlus 单序列）==========
CREATE TABLE IF NOT EXISTS ig_auth_daily (
  date       date        NOT NULL PRIMARY KEY,
  count      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========== funnel_stage_meta：47 阶段定义（播种自 funnel-events.mjs FUNNEL[]）==========
-- P1.2 起 DB 为事件定义的权威源；funnel-events.mjs 仅作初始种子。
--   enabled      : 是否参与拉取（false=停用，fetch-funnel 跳过）
--   source_split : 是否按 source(fb/tt/…) 拆分；false=只存日总额到 source='unknown'
--   indicator    : BytePlus event_indicator（默认 event_users=去重人数）
CREATE TABLE IF NOT EXISTS funnel_stage_meta (
  stage_key    text        NOT NULL PRIMARY KEY,   -- 如 "lp_show"
  ord          int         NOT NULL,               -- 0..46，控制 stages[] 顺序
  label        text        NOT NULL,               -- "投广页曝光"
  event_name   text        NOT NULL,               -- BytePlus event_name == Stage.name
  filters      jsonb,                              -- NULL 或 [{"property":..,"values":[..]}]
  enabled      boolean     NOT NULL DEFAULT true,
  source_split boolean     NOT NULL DEFAULT true,
  indicator    text        NOT NULL DEFAULT 'event_users',
  status       text,                              -- 运行时状态（ok / ok(by ...) / 失败:...）
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- 对已存在的旧表补列（幂等；新建库时为 no-op）
ALTER TABLE funnel_stage_meta ADD COLUMN IF NOT EXISTS enabled      boolean NOT NULL DEFAULT true;
ALTER TABLE funnel_stage_meta ADD COLUMN IF NOT EXISTS source_split boolean NOT NULL DEFAULT true;
ALTER TABLE funnel_stage_meta ADD COLUMN IF NOT EXISTS indicator    text    NOT NULL DEFAULT 'event_users';

-- ========== funnel_daily：date × stage_key × source -> 人数（原子事实）==========
-- unknown 作为普通 source 行存（值由 fetch-funnel.mjs 的 fillUnknown 算好，含 Math.max(0,…) 下限）
CREATE TABLE IF NOT EXISTS funnel_daily (
  date       date        NOT NULL,
  stage_key  text        NOT NULL REFERENCES funnel_stage_meta (stage_key) ON DELETE CASCADE,
  source     text        NOT NULL,               -- fb/tt/bff/AIguild/AIguild_active/AIguild_passive/unknown
  count      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, stage_key, source)
);
CREATE INDEX IF NOT EXISTS funnel_daily_stage_date_idx ON funnel_daily (stage_key, date);

-- ========== pull_runs：拉取日志（前端 /api/status 读最新一条）==========
CREATE TABLE IF NOT EXISTS pull_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  snapshot_ok boolean,
  funnel_ok   boolean,
  days        int,
  start_date  date,
  end_date    date,
  note        text
);
CREATE INDEX IF NOT EXISTS pull_runs_started_idx ON pull_runs (started_at DESC);

-- ========== ad_groups：广告账户/系列分组（修成本失真 + 数据源编组）==========
-- members: [{ "type":"account"|"campaign", "id":"...", "name":"..." }]
-- 解析：account 展开为其下全部 campaign_id；campaign 即自身；去重后 WHERE campaign_id IN (集合)
CREATE TABLE IF NOT EXISTS ad_groups (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text        NOT NULL,
  members      jsonb       NOT NULL DEFAULT '[]',
  is_app_group boolean     NOT NULL DEFAULT false,   -- 标记"某 App 的花费集合"（如 PWA）
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ========== dashboards / cards：多看板 + 卡片持久化（P2 自助搭建器）==========
-- board_filters: { window/dateFrom/dateTo, granularity, groupId?/accounts?/campaigns?/adsets?, channels?, sources? }
-- canvas: { x, y, w?, h? } —— v3 桌面画布上的坐标/尺寸（自由摆放）
CREATE TABLE IF NOT EXISTS dashboards (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL,
  board_filters jsonb       NOT NULL DEFAULT '{}',
  canvas        jsonb       NOT NULL DEFAULT '{}',
  is_template   boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- 对已存在旧表补列（幂等）
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS canvas jsonb NOT NULL DEFAULT '{}';
-- ========== xmp_fetch_config：XMP 抓取配置（DB 为权威源，飞书「XMP抓取配置」表为可编辑镜像）==========
-- 单表两类行，用 category 区分：
--   category='account'|'campaign' → 抓取范围（白名单）：value 填账户/系列的 id 或名称。
--        为空(无此类行) → 抓全部账户（现状，安全兜底）；有此类行 → 只抓匹配的（account∪campaign 并集）。
--   category='metric' → 抓哪些字段：value=XMP field id；store_layer=core(campaign_daily 三大列)|ext(长表)。
-- sync-config-from-feishu.mjs 每次运行：读飞书 → 校验 → 全量覆盖本表 → 回写状态。飞书不可达时保留上次配置。
DROP TABLE IF EXISTS fetch_field_config;  -- 旧的「仅字段」配置表，升级为下面的统一表
CREATE TABLE IF NOT EXISTS xmp_fetch_config (
  category    text        NOT NULL,                -- 'account' | 'campaign' | 'metric'
  value       text        NOT NULL,                -- 账户/系列 token 或 指标 field id
  name        text,                                -- 可读备注
  store_layer text,                                -- 'core' | 'ext'（仅 metric 用）
  enabled     boolean     NOT NULL DEFAULT true,
  status      text,                                -- 校验/运行状态（回写飞书）
  group_name  text,                                -- 归属：PWA / AI公会 / 上架包（仅 account 行用；决定花费算进哪个看板）
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, value)
);
ALTER TABLE xmp_fetch_config ADD COLUMN IF NOT EXISTS group_name text;

-- ========== campaign_metric_daily：扩展指标长表（EAV）==========
-- 配置里标 ext 的指标落这里，永不改表结构；核心 cost/impression/click 仍在 campaign_daily 宽表。
-- 主键含 metric_key → 同一广告行的每个扩展指标一行。写入幂等：按(覆盖日期 × 涉及 metric_key)删除+重灌。
CREATE TABLE IF NOT EXISTS campaign_metric_daily (
  date        date          NOT NULL,
  account_id  text          NOT NULL,
  campaign_id text          NOT NULL,
  adset_id    text          NOT NULL DEFAULT '_',
  metric_key  text          NOT NULL,
  value       numeric(20,4) NOT NULL DEFAULT 0,
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, account_id, campaign_id, adset_id, metric_key)
);
CREATE INDEX IF NOT EXISTS campaign_metric_daily_key_date_idx ON campaign_metric_daily (metric_key, date);

-- config: { measure, params{stage?/cvrFrom?/cvrTo?}, dims[], viz, cardFilters? }
-- layout: { x, y, w, h }（react-grid-layout 栅格）
CREATE TABLE IF NOT EXISTS cards (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dashboard_id bigint      NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  title        text        NOT NULL DEFAULT '',
  config       jsonb       NOT NULL DEFAULT '{}',
  layout       jsonb       NOT NULL DEFAULT '{}',
  ord          int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_dashboard_idx ON cards (dashboard_id);

-- ========== adgroup_daily_report：PWA 广告组日报 + 优化建议（累积日志）==========
-- 每天 9:00(UTC+8) 由 daily-adgroup-report.mjs 写入「前一天」每个在跑广告组的记录 + 规则化优化建议。
-- 只覆盖当前可用的 PWA facebook 账户（3_ymt 被封后 = 新_1_zmf / 新_4-ymt）。
-- 注册无法归因到广告组（BytePlus 只到 source 级），故广告组级只有花费/CTR/CPC；acct_cpa=两账户当日 fb 大盘单价（每行相同，仅上下文）。
-- 建议基于「近3日」窗口（比单日稳），字段口径见 daily-adgroup-report.mjs 的 THRESH 常量。
-- 幂等：按 date DELETE+INSERT。累积历史（PG 保全量；飞书镜像按需窗口）。
CREATE TABLE IF NOT EXISTS adgroup_daily_report (
  date          date          NOT NULL,
  account_id    text          NOT NULL,
  account_name  text          NOT NULL,
  campaign_id   text          NOT NULL,
  campaign_name text          NOT NULL,
  adset_id      text          NOT NULL DEFAULT '_',
  adset_name    text          NOT NULL DEFAULT '_',
  cost          numeric(18,4) NOT NULL DEFAULT 0,   -- 昨日花费
  impression    bigint        NOT NULL DEFAULT 0,
  click         bigint        NOT NULL DEFAULT 0,
  ctr           numeric(8,4)  NOT NULL DEFAULT 0,   -- 昨日 CTR %
  cpc           numeric(10,4) NOT NULL DEFAULT 0,   -- 昨日 CPC $
  cost3         numeric(18,4) NOT NULL DEFAULT 0,   -- 近3日花费
  ctr3          numeric(8,4)  NOT NULL DEFAULT 0,   -- 近3日 CTR %（建议依据）
  cpc3          numeric(10,4) NOT NULL DEFAULT 0,   -- 近3日 CPC $（建议依据）
  is_new        boolean       NOT NULL DEFAULT false, -- 首见≤2天前=新（测试期）
  action        text          NOT NULL,             -- 放量/维持/砍预算/暂停/测试观察
  priority      int           NOT NULL DEFAULT 5,
  reason        text          NOT NULL DEFAULT '',
  acct_cpa      numeric(10,4),                       -- 两账户当日 fb 大盘单价（上下文，每行相同）
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, account_id, campaign_id, adset_id)
);
CREATE INDEX IF NOT EXISTS adgroup_daily_report_date_idx ON adgroup_daily_report (date);

-- adgroup_daily_report 补列：可加量素材（该广告组内 CTR/CPC 达放量门槛的素材列表；无则「无」）
ALTER TABLE adgroup_daily_report ADD COLUMN IF NOT EXISTS scalable_ads text NOT NULL DEFAULT '';
-- adgroup_daily_report 补列：渠道（facebook / tiktok）——分渠道口径与展示
ALTER TABLE adgroup_daily_report ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'facebook';

-- ========== ad_daily：date × 账户 × 系列 × 广告组 × 素材(ad) 花费（来自 XMP ad 级，仅活跃 PWA 账户）==========
-- 由 fetch-ads.mjs 按 account_id 过滤拉取（只拉 lib/pwa-accounts 的活跃账户，轻量）。
-- 用途：daily-adgroup-report 据此算每个广告组内「可加量素材」。注册不能归因到素材，故只有 CTR/CPC 代理指标。
CREATE TABLE IF NOT EXISTS ad_daily (
  date          date          NOT NULL,
  account_id    text          NOT NULL,
  account_name  text          NOT NULL,
  campaign_id   text          NOT NULL,
  adset_id      text          NOT NULL DEFAULT '_',
  adset_name    text          NOT NULL DEFAULT '_',
  ad_id         text          NOT NULL,
  ad_name       text          NOT NULL DEFAULT '',
  cost          numeric(18,4) NOT NULL DEFAULT 0,
  impression    bigint        NOT NULL DEFAULT 0,
  click         bigint        NOT NULL DEFAULT 0,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, account_id, campaign_id, adset_id, ad_id)
);
CREATE INDEX IF NOT EXISTS ad_daily_date_idx ON ad_daily (date);
CREATE INDEX IF NOT EXISTS ad_daily_adset_date_idx ON ad_daily (account_id, adset_id, date);



-- ========== aiguild_os_daily：AI公会注册等阶段 按 os(android/ios) 拆（来自 BytePlus os_name 分组）==========
-- 供「AI公会分端汇总」分端(安卓/iOS)看转化。注册归因不到广告组但能到 os(用户设备属性 os_name)。
-- 由 fetch-aiguild-os.mjs 写：仅 AI公会来源(AIguild/active/passive)，按 os 聚合 4 个阶段人数。
CREATE TABLE IF NOT EXISTS aiguild_os_daily (
  date       date        NOT NULL,
  stage_key  text        NOT NULL,   -- cash_ready_show / withdraw_first / task_ins_bind / chengcai
  os         text        NOT NULL,   -- android / ios / other
  count      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, stage_key, os)
);
CREATE INDEX IF NOT EXISTS aiguild_os_daily_date_idx ON aiguild_os_daily (date);


-- ========== af_events：AppsFlyer Push API 实时原始事件（上架包/Google 投放，BytePlus 打点覆盖不到）==========
-- 由 app/api/af/push/route.ts 接收 AF Push API v2 的 POST/GET 写入，一条消息一行。
-- 设计要点（受 AF 协议约束）：
--   · AF 4 秒超时 → 只做一条 INSERT，不做任何派生计算；聚合放查询层。
--   · AF 空字段不发 → 所有列可空，除 raw/dedupe_key。
--   · AF 只在 5xx 时重试(15 分钟间隔×4)，且重发的是同一条报文 → dedupe_key = md5(整包 JSON)，
--     唯一索引 + ON CONFLICT DO NOTHING 天然幂等；重放不会产生重复行。
--   · 热字段拉平成列供查询/聚合，其余 100+ 字段全量留在 raw 里，不怕 AF 以后加字段。
CREATE TABLE IF NOT EXISTS af_events (
  id            bigserial     PRIMARY KEY,
  dedupe_key    text          NOT NULL,            -- md5(raw)，AF 重试幂等用
  received_at   timestamptz   NOT NULL DEFAULT now(),
  event_time    timestamptz,                       -- AF event_time（UTC，无时区后缀，按 UTC 解析）
  event_name    text,                              -- install / af_purchase / 自定义应用内事件名
  event_source  text,                              -- SDK / S2S
  appsflyer_id  text,                              -- AF 设备唯一 id
  customer_user_id text,                           -- CUID：自有用户 id，跨系统 join 的钥匙
  app_id        text,                              -- com.xxx（安卓）/ idNNNN（iOS）
  platform      text,                              -- android / ios
  media_source  text,                              -- googleadwords_int / Facebook Ads / bytedanceglobal_int …
  channel       text,                              -- af_channel
  campaign      text,
  campaign_id   text,                              -- af_c_id
  adset         text,                              -- af_adset
  adset_id      text,                              -- af_adset_id
  ad            text,                              -- af_ad
  ad_id         text,                              -- af_ad_id
  site_id       text,                              -- af_siteid（子渠道/发布商）
  is_retargeting boolean,
  attributed_touch_type text,                      -- click / impression
  install_time  timestamptz,
  country_code  text,
  city          text,
  ip            text,
  language      text,
  device_type   text,
  os_version    text,
  app_version   text,
  sdk_version   text,
  advertising_id text,                             -- GAID（安卓）
  idfa          text,                              -- iOS
  idfv          text,
  android_id    text,
  oaid          text,
  event_revenue        numeric(18,4),
  event_revenue_usd    numeric(18,4),
  event_revenue_currency text,
  event_value   jsonb,                             -- 应用内事件参数（AF 发的是 JSON 字符串，这里尽量解成 jsonb）
  raw           jsonb         NOT NULL,            -- 整包原始报文，字段增改不丢数据
  CONSTRAINT af_events_dedupe_uniq UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS af_events_event_time_idx   ON af_events (event_time DESC);
CREATE INDEX IF NOT EXISTS af_events_name_time_idx    ON af_events (event_name, event_time DESC);
CREATE INDEX IF NOT EXISTS af_events_media_time_idx   ON af_events (media_source, event_time DESC);
CREATE INDEX IF NOT EXISTS af_events_received_idx     ON af_events (received_at DESC);
CREATE INDEX IF NOT EXISTS af_events_cuid_idx         ON af_events (customer_user_id) WHERE customer_user_id IS NOT NULL;


-- ========== af_event_map：AF 事件名 → 业务阶段 映射（上架包漏斗的口径定义）==========
-- 为什么要这张表：AF 的 event_name 由 app 埋点决定，只有 install 是 AF 协议固定的标准事件，
-- 其余（注册/IG授权/…）各 app 各叫各的，且以后还会加。把映射放进 DB 而不是写死在代码里，
-- 加事件只改数据、不用改码部署。af_events 原始事件 join 本表即得分阶段人数。
-- stage_key 尽量与 funnel_stage_meta（BytePlus/PWA 侧）同名，方便两条链路的同口径对比。
CREATE TABLE IF NOT EXISTS af_event_map (
  af_event_name text        PRIMARY KEY,        -- AF 报文里的 event_name 原值
  stage_key     text        NOT NULL,           -- 业务阶段：app_install / cash_ready_show / task_ins_bind …
  label         text        NOT NULL,           -- 中文名：安装 / 注册 / IG授权完成
  ord           int         NOT NULL DEFAULT 0, -- 漏斗顺序
  enabled       boolean     NOT NULL DEFAULT true,
  note          text,                           -- 口径备注/待确认标记
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS af_event_map_stage_idx ON af_event_map (stage_key);


-- ========== key_metric_daily：date × 关键指标 × 地区 -> 数值（BytePlus 官方关键指标口径）==========
-- 口径定义在 lib/key-metrics.mjs（逐字对齐 BytePlus 报表「PWA 德州关键指标转化率看板」）。
--   metric_key : lp_show / install_success / register / distributable / ig_bind / chengcai
--   region     : TX(德州) / nonTX(非德州) / all(全量)
--   count      : UV 去重人数（成材是 PV 总次数，见 lib/key-metrics.mjs 注释）
-- 为什么独立于 funnel_daily：① 多一个地区维度 ② 成材口径不同(PV vs UV) ③ 官方看板的 6 个指标
-- 是独立一套"关键指标"，与 50 阶段全漏斗互不覆盖。三个地区都存行，不要用 all−TX 推 nonTX
-- （loc_province_id 按事件归因，跨州用户两边都算，TX+nonTX 略大于 all）。
CREATE TABLE IF NOT EXISTS key_metric_daily (
  date       date        NOT NULL,
  metric_key text        NOT NULL,
  region     text        NOT NULL,
  count      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, metric_key, region)
);
CREATE INDEX IF NOT EXISTS key_metric_daily_date_idx   ON key_metric_daily (date);
CREATE INDEX IF NOT EXISTS key_metric_daily_region_idx ON key_metric_daily (region, date);



-- ========== dms_metric_daily：自有后台业务库口径的关键指标（date × metric_key -> 数值）==========
-- 来源 = 阿里云 DMS 只读接口查 archat 库（fetch-dms.mjs），按 **America/Chicago 日**切，与
-- key_metric_daily 同一天界，可直接并排比较。
--   ig_bind  = user_common_task  task_id='110' AND status='FINISHED'（按 update_at 完成时间）
--   chengcai = user_withdraw_task amount='25'（按 create_at 申请时间，含各种 status）
-- 为什么单独一张表而不并进 key_metric_daily：**业务库拿不到地区维度**——user_geo_location.province
-- 脏（大量字面量 '0'、城市名混进州名、运营商名进 city），zip_code 只有 16% 覆盖 → 德州拆分只能靠
-- BytePlus。故本表**无 region 列**，只提供全量口径；看板里全量行优先用它，德州/非德州行仍走 BytePlus。
CREATE TABLE IF NOT EXISTS dms_metric_daily (
  date       date        NOT NULL,
  metric_key text        NOT NULL,
  count      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, metric_key)
);
CREATE INDEX IF NOT EXISTS dms_metric_daily_date_idx ON dms_metric_daily (date);


-- ========== xiaomei_conversion_daily：小美投放转化（date × 产品 × 渠道）==========
-- 由 fetch-xiaomei.mjs 每日 13:10(北京) 写入，供飞书「小美投放转化」表搭可视化看板。
-- 一行 = 某天某产品某渠道的投放侧(XMP) + 后端转化(BytePlus/AppsFlyer)。
--
-- 【为什么后端 4 列可空（NULL ≠ 0）】三个产品的后端数据在三套系统里，覆盖度不同：
--   NULL = 该产品这个指标**没有数据源**（如 Savvy 的 AF Push 还没配、上架包没有成材事件）——看板里留空；
--   0    = 数据源接了、当天确实是 0。
-- 混用会让「没接」和「真的是 0」在看板上长得一样，故用可空列区分。
--
-- 【日界】date 一律是 **America/Chicago 日**（= 北京 13:00 ~ 次日 13:00，冬令时 14:00），
-- 与 XMP 的整日花费按 D↔D 对齐（用户 2026-08-16 定的口径）。XMP 侧日期本身是上海日，两者
-- 不重切、只做标签对齐，与 lib/key-metrics.mjs 的处理一致（那里有为什么不重切花费的完整说明）。
--
-- 【渠道「未归因」行】后端指标能拆到渠道的才落 facebook/tiktok/google，拆不到的落「未归因」：
--   · PWA：注册/IG绑定/成材 走业务库（无渠道维度）→ 全进未归因；仅 GoLive 用 BytePlus 的 source 拆，
--     而 source 实测只有 39% 有标记（2026-08-16：全量 305 里 185 条无来源）→ 该指标渠道拆分基本不可用；
--   · AI公会：source 只标 AIguild*，**不带渠道信息** → 后端指标整体进未归因（花费仍按真实渠道分行）；
--   · SmartReply/Savvy：AF 的 media_source 能完整拆渠道，organic/空 进未归因。
--   同一产品同一天「各渠道行相加 = 产品总数」，看板按产品汇总时直接求和即可。
CREATE TABLE IF NOT EXISTS xiaomei_conversion_daily (
  date       date          NOT NULL,
  product    text          NOT NULL,            -- PWA / AI公会 / Savvy / SmartReply
  channel    text          NOT NULL,            -- facebook / tiktok / google / 未归因
  cost       numeric(18,4) NOT NULL DEFAULT 0,  -- 以下 4 列来自 XMP（campaign_daily / campaign_metric_daily）
  impression bigint        NOT NULL DEFAULT 0,
  click      bigint        NOT NULL DEFAULT 0,
  install    bigint        NOT NULL DEFAULT 0,  -- = XMP conversion（媒体侧回传；上架包=安装，PWA/AI公会=线索）
  register   bigint,                            -- 以下 4 列来自 BytePlus / AppsFlyer，NULL=无数据源
  ig_bind    bigint,
  golive     bigint,
  chengcai   bigint,                            -- PWA/AI公会 为 PV(次数)，与官方关键指标看板一致
  updated_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, product, channel)
);
CREATE INDEX IF NOT EXISTS xiaomei_conversion_daily_date_idx    ON xiaomei_conversion_daily (date);
CREATE INDEX IF NOT EXISTS xiaomei_conversion_daily_product_idx ON xiaomei_conversion_daily (product, date);

-- 「小美」= 当天还触发过 pwa_user_face_score 且 face_score >= 70 的那批人（用户 2026-08-19 定的口径）。
-- 目前**只有 Savvy 有**，其余产品恒为 NULL（它们没走这套口径）。
-- ⚠️ 这两列是**近似值、只会偏低**：BytePlus 接口做不到「同一人当天既做了 A 又做了 B」的无序交集，
--    只能用有序漏斗 [face_score>=70 → 目标事件] 取第二步人数，漏掉「先触发后打分」的人。
--    08-15 实测真值区间 [42,44]、漏斗给 42，偏差 <5%。完整论证见 lib/xiaomei.mjs 的 SAVVY_BYTEPLUS。
-- ⚠️ Savvy 的这四个指标（注册/IG绑定/小美注册/小美IG绑定）按 **Asia/Shanghai** 切日，
--    与本表其余部分的 America/Chicago 日界**不同**（用户 2026-08-19 拍板，为的是和给的 SQL 逐字一致，
--    顺带与 XMP 的上海日花费天然对齐）。跨产品横向比较时要知道这一点。
ALTER TABLE xiaomei_conversion_daily ADD COLUMN IF NOT EXISTS beauty_register bigint;
ALTER TABLE xiaomei_conversion_daily ADD COLUMN IF NOT EXISTS beauty_ig_bind  bigint;


-- ========== xiaomei_channel_daily：小美投放转化的**预聚合**汇总（date × 产品 × 渠道）==========
-- 由 fetch-xiaomei.mjs 在写完明细表后从 xiaomei_conversion_daily 直接聚合出来，供飞书仪表盘画图。
--
-- 【为什么必须有这张表】飞书仪表盘的图表组件只能对**单个字段**做 SUM/MAX/MIN/AVERAGE，**算不了比值**。
-- 如果直接拿明细表画「注册单价」，飞书只能对各行的单价求和或求平均 —— 而比值跨行求平均是错的
-- （$100/10人 与 $1/1人 的真实单价是 $9.18，平均法给出 $5.5）。所以单价/CPM/CTR/CPC 必须在这里
-- **按分量重算**（SUM(花费)/SUM(转化)），并且让每个 (日期,产品,渠道) 组合**只有一行**，图表 SUM
-- 一行 = 取到正确的值。
--
-- 【小计行】用 GROUPING SETS 一次算出四个粒度，产品/渠道的合计值写成字面量「全部」：
--   (日期,产品,渠道) 明细 · (日期,产品)=渠道'全部' · (日期,渠道)=产品'全部' · (日期)=两者都'全部'
--   ⚠️ 因此**做图必须筛掉不需要的小计行**，否则会重复计算（如按渠道分组时要 产品='全部'）。
--
-- 【单价的成本口径】各指标只用「有该指标数据的产品」的花费当分子：
--   注册单价 = SUM(花费 WHERE 注册非空)/SUM(注册)。不这么做的话，上架包有花费没注册回传，
--   会把注册单价凭空抬高好几倍。分母为 0/空 → 单价为 NULL（图上断点，不画成 0）。
--
-- 【is_latest】标记「全表最新一天」，给指标卡当筛选条件用（飞书的日期筛选只能填死时间戳，
--   不会自己往前滚）。每轮跑全表刷新一次，只有最新日为 true。
CREATE TABLE IF NOT EXISTS xiaomei_channel_daily (
  date              date          NOT NULL,
  product           text          NOT NULL,   -- PWA / AI公会 / Savvy / SmartReply / 全部
  channel           text          NOT NULL,   -- facebook / tiktok / google / 未归因 / 全部
  cost              numeric(18,4) NOT NULL DEFAULT 0,
  impression        bigint        NOT NULL DEFAULT 0,
  click             bigint        NOT NULL DEFAULT 0,
  install           bigint        NOT NULL DEFAULT 0,
  register          bigint,                   -- 后端 4 指标沿用明细表的可空语义：NULL=无数据源
  ig_bind           bigint,
  golive            bigint,
  chengcai          bigint,
  cpm               numeric(12,4),            -- 以下比值全部从分量重算，分母为 0 时为 NULL
  ctr               numeric(8,4),             -- %
  cpc               numeric(12,4),
  cost_per_install  numeric(12,4),
  cost_per_register numeric(12,4),
  cost_per_ig_bind  numeric(12,4),
  cost_per_chengcai numeric(12,4),
  is_latest         boolean       NOT NULL DEFAULT false,
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (date, product, channel)
);
CREATE INDEX IF NOT EXISTS xiaomei_channel_daily_date_idx ON xiaomei_channel_daily (date);

-- 小美两列 + 小美注册单价（语义与明细表一致；单价同样只在 渠道='全部' 的粒度算，
-- 因为小美两列落「未归因」行、那行花费为 0，渠道明细行上分子分母不在一起）。
ALTER TABLE xiaomei_channel_daily ADD COLUMN IF NOT EXISTS beauty_register          bigint;
ALTER TABLE xiaomei_channel_daily ADD COLUMN IF NOT EXISTS beauty_ig_bind           bigint;
ALTER TABLE xiaomei_channel_daily ADD COLUMN IF NOT EXISTS cost_per_beauty_register numeric(12,4);
