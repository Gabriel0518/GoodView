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
CREATE TABLE IF NOT EXISTS funnel_stage_meta (
  stage_key  text        NOT NULL PRIMARY KEY,   -- 如 "lp_show"
  ord        int         NOT NULL,               -- 0..46，控制 stages[] 顺序
  label      text        NOT NULL,               -- "投广页曝光"
  event_name text        NOT NULL,               -- BytePlus event_name == Stage.name
  filters    jsonb,                              -- NULL 或 [{"property":..,"values":[..]}]
  status     text,                              -- 运行时状态（ok / ok(by ...) / 失败:...）
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

