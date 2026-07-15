// XMP 抓取配置：飞书「XMP抓取配置」表 → Postgres xmp_fetch_config（反向同步，唯一飞书为权威的方向）。
// 每次 pull 前跑一次：读飞书 → 校验（账户/系列非空；指标白名单+中英别名）→ 覆盖 xmp_fetch_config → 回写状态。
// 失败保护：飞书读不到（未建表/网络）→ 打警告直接返回，保留 DB 上次 last-known-good，绝不清空。
// 用法：node sync-config-from-feishu.mjs
import { tableIdMap, listRecords, batchUpdate, cellStr, cellBool } from "./lib/feishu.mjs";
import { xmpConfigTable } from "./feishu-tables.mjs";
import { validateConfigRow } from "./lib/whitelist.mjs";
import { withTx, end } from "./lib/db.mjs";
import { FEISHU } from "./config.mjs";

const F = xmpConfigTable.F;

async function main() {
  if (!FEISHU.appToken) {
    console.log("[配置同步] 未配置 FEISHU_APP_TOKEN，跳过（用 DB 现有配置）。");
    return;
  }

  // 1) 定位飞书配置表（未建表则跳过，保留 DB）
  let tableId;
  try {
    tableId = (await tableIdMap())[xmpConfigTable.name];
  } catch (e) {
    console.warn(`  ⚠️ 读飞书表列表失败（保留 DB 配置）：${e.message}`);
    return;
  }
  if (!tableId) {
    console.warn(`  ⚠️ 飞书里没有「${xmpConfigTable.name}」表（先跑 node feishu-init-tables.mjs）。保留 DB 配置。`);
    return;
  }

  // 2) 读全部记录（失败则保留 DB）
  let records;
  try {
    records = await listRecords(tableId);
  } catch (e) {
    console.warn(`  ⚠️ 读飞书配置记录失败（保留 DB 配置）：${e.message}`);
    return;
  }

  // 3) 逐行校验
  const valid = [];      // { category, value, name, store_layer, enabled }
  const writeback = [];  // { record_id, fields:{状态} }
  const seen = new Set();
  const counts = { account: 0, campaign: 0, metric: 0 };
  for (const rec of records) {
    const f = rec.fields || {};
    const category = cellStr(f[F.category]).trim();
    const value = cellStr(f[F.value]).trim();
    const name = cellStr(f[F.name]).trim();
    const layer = cellStr(f[F.layer]).trim();
    const enabled = cellBool(f[F.enabled]);
    if (!value && !category) continue; // 完全空行忽略

    const v = validateConfigRow({ category, value, layer });
    let status;
    if (!v.ok) {
      status = `❌ ${v.reason}`;
    } else {
      const key = `${v.kind}:${v.value}`;
      if (seen.has(key)) {
        status = `❌ 重复：${category}/${v.value} 已在上方出现`;
      } else {
        seen.add(key);
        valid.push({ category: v.kind, value: v.value, name: name || null, store_layer: v.layer || null, enabled });
        if (enabled) counts[v.kind]++;
        const tag = v.kind === "metric" ? `${v.label}(${v.layer})` : v.kind === "account" ? "账户" : "系列";
        status = enabled ? `✅ ${tag}` : `⏸ 已停用（${tag}）`;
      }
    }
    if (cellStr(f[F.status]) !== status) writeback.push({ record_id: rec.record_id, fields: { [F.status]: status } });
  }

  // 4) 覆盖 xmp_fetch_config（成功读到飞书才 reconcile：删旧+插新 → 飞书移除的行即停止抓取，历史数据不回删）
  await withTx(async (c) => {
    await c.query(`DELETE FROM xmp_fetch_config`);
    for (const r of valid) {
      await c.query(
        `INSERT INTO xmp_fetch_config (category, value, name, store_layer, enabled, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())`,
        [r.category, r.value, r.name, r.store_layer, r.enabled, r.enabled ? "ok" : "disabled"],
      );
    }
  });

  // 5) 回写状态到飞书（失败不影响 DB）
  let wrote = 0;
  if (writeback.length) {
    try { wrote = await batchUpdate(tableId, writeback); }
    catch (e) { console.warn(`  ⚠️ 状态回写飞书失败（不影响 DB）：${e.message}`); }
  }

  const scope = counts.account || counts.campaign
    ? `范围=白名单（账户 ${counts.account} · 系列 ${counts.campaign}）`
    : `范围=全部账户（无账户/系列行）`;
  console.log(
    `[配置同步] 飞书 ${records.length} 行 → 有效 ${valid.length} · 启用指标 ${counts.metric} · ${scope} · 回写状态 ${wrote} 行`,
  );
}

main()
  .catch((e) => { console.error("配置同步失败：", e.message); process.exitCode = 1; })
  .finally(() => end().catch(() => {}));
