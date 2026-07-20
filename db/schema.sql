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
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, value)
);

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


