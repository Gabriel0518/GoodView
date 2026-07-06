// XMP (Nativex/Mobvista) 取数模块
import crypto from "node:crypto";
import { XMP } from "../config.mjs";
import { fetchRetry } from "./http.mjs";

// 公共鉴权参数：sign = md5(client_secret + timestamp)，timestamp 30 秒内有效
function authParams() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto
    .createHash("md5")
    .update(XMP.clientSecret + String(timestamp))
    .digest("hex");
  return { client_id: XMP.clientId, timestamp, sign };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchRetry(XMP.gateway + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...authParams(), ...body }),
    });
    const json = await res.json();
    if (json.code === 0) return json.data;

    const msg = json.msg || JSON.stringify(json);
    // QPM=10 限频：等到下一分钟再试
    if (/frequent|频繁/i.test(msg) && attempt < 4) {
      const wait = 15000 + attempt * 10000;
      console.warn(`  ⚠️ XMP 限频(QPM=10)，${Math.round(wait / 1000)}s 后重试…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`XMP ${path} code=${json.code} ${msg}`);
  }
}

// 拉取广告报表，自动翻页。filters 可传 campaign_id/adset_id/ad_id/account_id 等过滤条件。
export async function fetchReport({ startDate, endDate, dimension = ["date"], metrics, filters = {} }) {
  const rows = [];
  let page = 1;
  for (;;) {
    const data = await call("/v2/media/account/report", {
      start_date: startDate,
      end_date: endDate,
      dimension,
      metrics,
      ...filters,
      page,
      page_size: 1000,
    });
    const list = data.list || [];
    rows.push(...list);
    if (list.length < 1000) break; // 不足一页 => 到底
    page++;
  }
  return rows;
}
