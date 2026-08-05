// 飞书视图排序：让镜像表在飞书里恒按日期新→旧展示。
//
// 增量窗口同步每轮「删本窗口 + 追加重灌」，飞书记录的物理顺序 = 历次追加的拼接结果，必然乱序
// （老历史在最前，每轮窗口跟在后面）。插入顺序管不了展示顺序，只能给视图挂持久排序规则。
//
// ⚠️ 排序接口在 base/v3，不在 bitable/v1（后者的「更新视图」只认 filter/hidden_fields，无排序）。
// ⚠️ 需要自建应用开通 base:view:write_only 权限，否则 99991672。调用方要容错（缺权限不该阻断同步）。
import { listFields, listViews, setViewSort } from "./feishu.mjs";

// 优先按「日期」排（语义列，用户一眼看懂）；没有则退回 date_num（整数 YYYYMMDD）。
const DATE_FIELDS = ["日期", "date_num"];
// 汇总表没有日期，用「排序」数字列定周期次序（近1/7/14/30日），升序更自然。
const SUMMARY_FIELD = "排序";

// 决定一张表该按哪一列、什么方向排。返回 null = 这张表不需要排序（如配置表）。
export function sortRuleFor(fieldNames) {
  const set = fieldNames instanceof Set ? fieldNames : new Set(fieldNames);
  const dateField = DATE_FIELDS.find((f) => set.has(f));
  if (dateField) return { field: dateField, desc: true };
  if (set.has(SUMMARY_FIELD)) return { field: SUMMARY_FIELD, desc: false };
  return null;
}

// 给一张表的所有表格视图挂上排序。返回 { rule, views, ok, errors }。
// 幂等：重复设同一规则无副作用。
export async function applyViewSort(tableId, rule) {
  const r = rule || sortRuleFor((await listFields(tableId)).map((f) => f.field_name));
  if (!r) return { rule: null, views: 0, ok: 0, errors: [] };

  // 只动表格视图（grid）；看板/画册/表单不碰
  const grids = (await listViews(tableId)).filter((v) => !v.view_type || v.view_type === "grid");
  let ok = 0;
  const errors = [];
  for (const v of grids) {
    try { await setViewSort(tableId, v.view_id, [{ field: r.field, desc: r.desc }]); ok++; }
    catch (e) { errors.push(`${v.view_name}: ${e.message}`); }
  }
  return { rule: r, views: grids.length, ok, errors };
}

export const ruleText = (r) => (r ? `${r.field} ${r.desc ? "降序(新→旧)" : "升序"}` : "无需排序");
