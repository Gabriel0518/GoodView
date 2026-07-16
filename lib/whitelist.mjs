// XMP 抓取配置白名单 + 校验。配置表两类行：账户/系列（抓取范围）+ 指标（抓哪些字段）。
//
// 指标是 XMP 官方枚举，填错会被 API 拒/静默返回空列 → 必须校验。权威源是 report/fields(report_type=ad)；
// 此处 curated + 中文别名，方便业务同学直接填「曝光/花费/线索」。如需新指标：确认 XMP field ID 后加进 METRICS。
// 账户/系列行只校验非空（值可填 account_id/campaign_id 或其名称，抓取时对 id 与 name 双向匹配）。

// id=XMP field ID；zh=中文别名（第一个作展示名）；core=可落 campaign_daily 三大列。
const METRICS = [
  { id: "cost",                     zh: ["花费", "消耗"],       core: true },
  { id: "impression",               zh: ["曝光", "展示"],       core: true },
  { id: "click",                    zh: ["点击"],               core: true },
  { id: "cpm",                      zh: ["千次展示成本"] },
  { id: "ctr",                      zh: ["点击率"] },
  { id: "cpc",                      zh: ["单次点击成本"] },
  { id: "active_register",          zh: ["注册", "注册数"] },
  { id: "cost_per_active_register", zh: ["注册单价"] },
  { id: "active_register_rate",     zh: ["注册率"] },
  { id: "active_pay",               zh: ["付费", "付费数"] },
];

export const XMP_CORE_METRICS = METRICS.filter((m) => m.core).map((m) => m.id);

// 别名表：id 与每个中文别名都映射到规范 id。
const ALIAS = new Map();
for (const m of METRICS) { ALIAS.set(m.id, m.id); for (const z of m.zh) ALIAS.set(z, m.id); }

export function resolveMetric(input) { return ALIAS.get((input || "").trim()) || null; }
export function metricZh(id) { const m = METRICS.find((x) => x.id === id); return m ? m.zh[0] : id; }

// 飞书「类别」单选的中文值 ↔ 内部 kind
export const CATEGORIES = { account: "广告账户", campaign: "广告系列", metric: "指标" };
export const CATEGORY_OPTIONS = [CATEGORIES.account, CATEGORIES.campaign, CATEGORIES.metric];
export const STORE_LAYERS = ["core", "ext"];

const metricHint = () => METRICS.map((m) => `${m.zh[0]}/${m.id}`).join("、");

// 校验一行配置。返回 { ok, kind, value, layer?, label?, reason }。
//   kind: 'account' | 'campaign' | 'metric'；metric 的 value 规范化为 XMP id。
export function validateConfigRow({ category, value, layer }) {
  const cat = (category || "").trim();
  const v = (value || "").trim();
  if (!v) return { ok: false, reason: "值为空" };

  if (cat === CATEGORIES.metric) {
    const id = resolveMetric(v);
    if (!id) return { ok: false, reason: `未知指标「${v}」（可填：${metricHint()}）` };
    let lyr = (layer || "").trim().toLowerCase();
    if (!lyr) lyr = XMP_CORE_METRICS.includes(id) ? "core" : "ext";
    if (!STORE_LAYERS.includes(lyr)) return { ok: false, reason: `未知落库层「${layer}」（core/ext）` };
    if (lyr === "core" && !XMP_CORE_METRICS.includes(id)) {
      return { ok: false, reason: `「${metricZh(id)}」不能进 core（仅 ${XMP_CORE_METRICS.join("/")}），请改 ext` };
    }
    return { ok: true, kind: "metric", value: id, layer: lyr, label: metricZh(id) };
  }
  if (cat === CATEGORIES.account)  return { ok: true, kind: "account",  value: v };
  if (cat === CATEGORIES.campaign) return { ok: true, kind: "campaign", value: v };
  return { ok: false, reason: `未知类别「${cat}」（${CATEGORY_OPTIONS.join(" / ")}）` };
}
