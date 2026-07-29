import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { q } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// AppsFlyer Push API v2 接收端点 —— 上架包(Google 投放)的事件走 AF，不在 BytePlus PWA 应用下。
//
// AF 协议约束（决定了下面每个设计选择，改之前先看这里）：
//   1) 4 秒超时（后台「Send Test」只有 2 秒），超时即判失败 → 只做一条 INSERT，不做派生计算；
//      并加 3 秒硬闸，宁可返回 5xx 让 AF 重试，也不要挂在那儿等到 AF 判超时。
//   2) 只有 5xx 才重试（15 分钟间隔，最多 4 次）→ 库写失败必须回 5xx；鉴权失败回 401（不该重试）。
//   3) 去重是接收方责任：重试发的是同一条报文 → dedupe_key = md5(整包 JSON)，
//      唯一索引 + ON CONFLICT DO NOTHING，重放天然幂等。
//   4) 不支持自定义 header，只认 Authorization；额外参数只能塞 URL → token 两种都收。
//   5) 空字段不发（连 key 一起省略）→ 所有字段按可选处理。
//
// 配置：AF 后台 Export > API Access > Push API > Add Endpoint
//   POST  https://<域名>/api/af/push?token=<AF_PUSH_TOKEN>
// GET 也支持（AF 允许选 GET，字段走 query string）；不带 event_name 的 GET = 健康检查。

const TOKEN = process.env.AF_PUSH_TOKEN || "";
const WRITE_DEADLINE_MS = 3000; // < AF 的 4s 超时，留出网络往返

// AF 的时间形如 "2019-12-31 00:07:14.961"（UTC，无时区后缀）→ 补 Z 按 UTC 解析。
// 带时区的（event_time_selected_timezone: "...+0000"）原样交给 Postgres。
function parseTs(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.trim() === "" || s === "null" ? null : s;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["true", "1", "yes"].includes(s)) return true;
  if (["false", "0", "no"].includes(s)) return false;
  return null;
}

function numOrNull(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// event_value AF 发的是 JSON 字符串（也可能已是对象）；解不动就原样包成 {"_raw": "..."} 别丢。
function jsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : JSON.stringify({ _raw: s });
  } catch {
    return JSON.stringify({ _raw: s });
  }
}

// token 校验：Authorization header（AF 的 Push API Authentication Token）或 URL 的 ?token=。
// 未配置 AF_PUSH_TOKEN 时放行并在响应里提示——方便先接通，但生产必须配上。
function authOk(req: Request, url: URL): boolean {
  if (!TOKEN) return true;
  const qp = url.searchParams.get("token");
  if (qp && qp === TOKEN) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === TOKEN || auth.replace(/^Bearer\s+/i, "") === TOKEN;
}

async function insert(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const dedupeKey = createHash("md5").update(raw).digest("hex");
  const r = await q(
    `INSERT INTO af_events (
       dedupe_key, event_time, event_name, event_source, appsflyer_id, customer_user_id,
       app_id, platform, media_source, channel, campaign, campaign_id, adset, adset_id, ad, ad_id, site_id,
       is_retargeting, attributed_touch_type, install_time, country_code, city, ip, language,
       device_type, os_version, app_version, sdk_version,
       advertising_id, idfa, idfv, android_id, oaid,
       event_revenue, event_revenue_usd, event_revenue_currency, event_value, raw
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       $18,$19,$20,$21,$22,$23,$24,
       $25,$26,$27,$28,
       $29,$30,$31,$32,$33,
       $34,$35,$36,$37::jsonb,$38::jsonb
     )
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      dedupeKey, parseTs(payload.event_time), str(payload.event_name), str(payload.event_source),
      str(payload.appsflyer_id), str(payload.customer_user_id),
      str(payload.app_id), str(payload.platform), str(payload.media_source), str(payload.af_channel),
      str(payload.campaign), str(payload.af_c_id), str(payload.af_adset), str(payload.af_adset_id),
      str(payload.af_ad), str(payload.af_ad_id), str(payload.af_siteid),
      bool(payload.is_retargeting), str(payload.attributed_touch_type), parseTs(payload.install_time),
      str(payload.country_code), str(payload.city), str(payload.ip), str(payload.language),
      str(payload.device_type), str(payload.os_version), str(payload.app_version), str(payload.sdk_version),
      str(payload.advertising_id), str(payload.idfa), str(payload.idfv), str(payload.android_id), str(payload.oaid),
      numOrNull(payload.event_revenue), numOrNull(payload.event_revenue_usd), str(payload.event_revenue_currency),
      jsonOrNull(payload.event_value), raw,
    ],
  );
  return { stored: r.rows.length > 0, duplicate: r.rows.length === 0 };
}

// 库写挂 3 秒硬闸：超时就回 5xx 让 AF 15 分钟后重试，别拖到 AF 自己判超时。
async function insertWithDeadline(payload: Record<string, unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      insert(payload),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`写库超过 ${WRITE_DEADLINE_MS}ms`)), WRITE_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handle(req: Request, payload: Record<string, unknown>) {
  const url = new URL(req.url);
  if (!authOk(req, url)) {
    // 401 而不是 5xx：鉴权错了重试多少次都没用，别让 AF 白跑 4 次。
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!payload || Object.keys(payload).length === 0) {
    return NextResponse.json({ ok: false, error: "empty payload" }, { status: 400 });
  }
  try {
    const { stored, duplicate } = await insertWithDeadline(payload);
    return NextResponse.json({
      ok: true, stored, duplicate,
      event: str(payload.event_name), media_source: str(payload.media_source),
      ...(TOKEN ? {} : { warning: "AF_PUSH_TOKEN 未配置，端点当前无鉴权" }),
    });
  } catch (e: unknown) {
    // 500 → AF 会在 15 分钟后重试，数据不丢。
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let payload: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // 兜底：万一发的是 form-encoded
        payload = Object.fromEntries(new URLSearchParams(text));
      }
    }
  } catch {
    return NextResponse.json({ ok: false, error: "unreadable body" }, { status: 400 });
  }
  // POST 也把 query 参数并进来（AF 的额外参数只能走 URL），但不把 token 存进库。
  const url = new URL(req.url);
  const qp = Object.fromEntries(url.searchParams);
  delete qp.token;
  return handle(req, { ...qp, ...payload });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);
  delete params.token;
  // 不带 event_name = 健康检查（也方便浏览器直接打开确认端点活着）
  if (!params.event_name) {
    if (!authOk(req, url)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    try {
      const r = await q<{ total: string; last_at: string | null; last_event: string | null }>(
        `SELECT count(*)::text AS total,
                max(received_at)::text AS last_at,
                (SELECT event_name FROM af_events ORDER BY received_at DESC LIMIT 1) AS last_event
         FROM af_events`,
      );
      return NextResponse.json({
        ok: true, endpoint: "appsflyer push api receiver",
        stored_events: Number(r.rows[0]?.total || 0),
        last_received_at: r.rows[0]?.last_at || null,
        last_event: r.rows[0]?.last_event || null,
        auth: TOKEN ? "token required" : "OPEN — 未配置 AF_PUSH_TOKEN",
      });
    } catch (e: unknown) {
      return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
    }
  }
  return handle(req, params);
}
