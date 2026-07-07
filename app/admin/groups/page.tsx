"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Panel, Button } from "../../components/ui";
import { MultiSelect } from "../../components/controls";
import { fmtMoney, cn } from "../../lib/util";

// ── 类型（对齐 API 契约）─────────────────────────────────────
type MemberType = "account" | "campaign";
type Member = { type: MemberType; id: string; name: string };
type Group = { id: number; name: string; members: Member[]; is_app_group: boolean };

type CandidateAccount = { id: string; name: string; cost: number };
type CandidateCampaign = { id: string; name: string; account_id: string; cost: number };
type Candidates = { accounts: CandidateAccount[]; campaigns: CandidateCampaign[] };

// 编辑器草稿
type Draft = {
  id: number | null; // null = 新建
  name: string;
  is_app_group: boolean;
  accountIds: string[];
  campaignIds: string[];
};

const EMPTY_DRAFT: Draft = { id: null, name: "", is_app_group: false, accountIds: [], campaignIds: [] };

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 拉取分组列表
  const loadGroups = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await jfetch<Group[]>("/api/groups");
      setGroups(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 拉取候选（账户 / 系列）
  const loadCandidates = useCallback(async () => {
    setCandErr(null);
    try {
      const data = await jfetch<Candidates>("/api/groups/candidates");
      setCandidates({
        accounts: Array.isArray(data?.accounts) ? data.accounts : [],
        campaigns: Array.isArray(data?.campaigns) ? data.campaigns : [],
      });
    } catch (e: any) {
      setCandErr(String(e?.message || e));
      setCandidates({ accounts: [], campaigns: [] });
    }
  }, []);

  useEffect(() => {
    loadGroups();
    loadCandidates();
  }, [loadGroups, loadCandidates]);

  // 候选映射（id → 名称/成本），用于渲染 chip 与选项
  const accById = useMemo(() => {
    const m = new Map<string, CandidateAccount>();
    (candidates?.accounts ?? []).forEach((a) => m.set(a.id, a));
    return m;
  }, [candidates]);
  const campById = useMemo(() => {
    const m = new Map<string, CandidateCampaign>();
    (candidates?.campaigns ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [candidates]);

  const accountOptions = useMemo(
    () => (candidates?.accounts ?? []).map((a) => ({ value: a.id, label: a.name, hint: fmtMoney(a.cost) })),
    [candidates],
  );
  const campaignOptions = useMemo(
    () =>
      (candidates?.campaigns ?? []).map((c) => {
        const acc = accById.get(c.account_id);
        return { value: c.id, label: c.name, hint: acc ? acc.name : fmtMoney(c.cost) };
      }),
    [candidates, accById],
  );

  // ── 编辑器操作 ───────────────────────────────────────────
  const openNew = () => {
    setSaveErr(null);
    setDraft({ ...EMPTY_DRAFT });
  };
  const openEdit = (g: Group) => {
    setSaveErr(null);
    setDraft({
      id: g.id,
      name: g.name,
      is_app_group: g.is_app_group,
      accountIds: g.members.filter((m) => m.type === "account").map((m) => m.id),
      campaignIds: g.members.filter((m) => m.type === "campaign").map((m) => m.id),
    });
  };
  const closeEditor = () => {
    setDraft(null);
    setSaveErr(null);
  };

  // 草稿 → members（尽量补齐名称）
  const draftMembers = useMemo<Member[]>(() => {
    if (!draft) return [];
    const acc: Member[] = draft.accountIds.map((id) => ({ type: "account", id, name: accById.get(id)?.name ?? id }));
    const camp: Member[] = draft.campaignIds.map((id) => ({ type: "campaign", id, name: campById.get(id)?.name ?? id }));
    return [...acc, ...camp];
  }, [draft, accById, campById]);

  const draftCost = useMemo(() => {
    if (!draft) return 0;
    const a = draft.accountIds.reduce((s, id) => s + (accById.get(id)?.cost ?? 0), 0);
    const c = draft.campaignIds.reduce((s, id) => s + (campById.get(id)?.cost ?? 0), 0);
    return a + c;
  }, [draft, accById, campById]);

  const removeMember = (type: MemberType, id: string) => {
    setDraft((d) =>
      d
        ? type === "account"
          ? { ...d, accountIds: d.accountIds.filter((x) => x !== id) }
          : { ...d, campaignIds: d.campaignIds.filter((x) => x !== id) }
        : d,
    );
  };

  const canSave = !!draft && draft.name.trim().length > 0 && draftMembers.length > 0 && !saving;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveErr(null);
    const body = {
      ...(draft.id != null ? { id: draft.id } : {}),
      name: draft.name.trim(),
      members: draftMembers,
      is_app_group: draft.is_app_group,
    };
    try {
      await jfetch(draft.id != null ? "/api/groups" : "/api/groups", {
        method: draft.id != null ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      closeEditor();
      await loadGroups();
    } catch (e: any) {
      setSaveErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const remove = async (g: Group) => {
    if (!window.confirm(`删除分组「${g.name}」？此操作不可撤销。`)) return;
    setDeletingId(g.id);
    setErr(null);
    try {
      await jfetch(`/api/groups?id=${encodeURIComponent(g.id)}`, { method: "DELETE" });
      if (draft?.id === g.id) closeEditor();
      await loadGroups();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setDeletingId(null);
    }
  };

  const candidatesEmpty =
    candidates && candidates.accounts.length === 0 && candidates.campaigns.length === 0;

  // ── 渲染 ────────────────────────────────────────────────
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      {/* 头部 */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">广告分组</h1>
          <p className="mt-1 max-w-xl text-xs text-zinc-500">
            把某个 App 的广告账户/系列编成组，成本只按组内花费算。用于将不同 App 的投放花费彼此隔离。
          </p>
        </div>
        <Button variant="primary" onClick={openNew}>
          + 新建组
        </Button>
      </div>

      {/* 候选拉取失败提示 */}
      {candErr && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
          无法加载候选账户/系列（{candErr}）。请先运行数据拉取 / 迁移，再回来创建分组。
        </div>
      )}

      {/* 编辑器 */}
      {draft && (
        <Panel
          title={draft.id != null ? "编辑组" : "新建组"}
          subtitle="选择归属该组的广告账户与广告系列"
          action={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={closeEditor}>
                取消
              </Button>
              <Button variant="primary" onClick={save} disabled={!canSave}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            {/* 名称 + App组开关 */}
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-[220px]">
                <label className="mb-1 block text-xs text-zinc-500">组名称</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                  placeholder="例如：PWA · 653834"
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent"
                />
              </div>
              <label className="mt-5 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={draft.is_app_group}
                  onChange={(e) => setDraft((d) => (d ? { ...d, is_app_group: e.target.checked } : d))}
                  className="accent-accent"
                />
                标记为 App 组
              </label>
            </div>

            {/* 成员选择器 */}
            <div className="flex flex-wrap items-center gap-3">
              <MultiSelect
                label="广告账户"
                options={accountOptions}
                selected={draft.accountIds}
                onChange={(v) => setDraft((d) => (d ? { ...d, accountIds: v } : d))}
                searchable
                emptyLabel="选择账户"
              />
              <MultiSelect
                label="广告系列"
                options={campaignOptions}
                selected={draft.campaignIds}
                onChange={(v) => setDraft((d) => (d ? { ...d, campaignIds: v } : d))}
                searchable
                emptyLabel="选择系列"
              />
              <span className="text-xs text-zinc-600">
                已选 {draftMembers.length} 项 · 组内花费 <span className="tnum text-accent-soft">{fmtMoney(draftCost)}</span>
              </span>
            </div>

            {/* 已选成员 chips */}
            {draftMembers.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {draftMembers.map((m) => (
                  <span
                    key={`${m.type}:${m.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-zinc-200"
                  >
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 text-[10px] font-medium",
                        m.type === "account" ? "bg-accent/20 text-accent-soft" : "bg-ink-700 text-zinc-400",
                      )}
                    >
                      {m.type === "account" ? "账户" : "系列"}
                    </span>
                    <span className="max-w-[200px] truncate" title={m.name}>
                      {m.name}
                    </span>
                    <button
                      onClick={() => removeMember(m.type, m.id)}
                      className="text-zinc-600 hover:text-zinc-200"
                      title="移除"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-zinc-600">
                {candidatesEmpty ? "暂无可选账户/系列，请先拉取数据" : "尚未选择成员 · 至少选择一个账户或系列"}
              </div>
            )}

            {saveErr && <div className="text-xs text-red-400">保存失败：{saveErr}</div>}
          </div>
        </Panel>
      )}

      {/* 分组列表 */}
      <Panel
        title="已有分组"
        subtitle={groups ? `${groups.length} 个组` : undefined}
        action={
          <Button variant="ghost" onClick={loadGroups} disabled={loading}>
            {loading ? "加载中…" : "刷新"}
          </Button>
        }
      >
        {loading ? (
          <div className="py-8 text-center text-xs text-zinc-600">加载中…</div>
        ) : err ? (
          <div className="space-y-2 py-6 text-center">
            <div className="text-xs text-red-400">加载失败：{err}</div>
            <div className="text-[11px] text-zinc-600">若 /api/groups 尚未上线，请等待后端接口就绪。</div>
          </div>
        ) : !groups || groups.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-600">
            还没有分组。点击右上角「新建组」创建第一个。
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const accCount = g.members.filter((m) => m.type === "account").length;
              const campCount = g.members.filter((m) => m.type === "campaign").length;
              return (
                <div
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-100" title={g.name}>
                        {g.name}
                      </span>
                      {g.is_app_group && (
                        <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-soft">
                          App组
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {g.members.length} 个成员
                      <span className="text-zinc-600">
                        {" "}
                        · {accCount} 账户 · {campCount} 系列
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={() => openEdit(g)}>编辑</Button>
                    <Button variant="ghost" onClick={() => remove(g)} disabled={deletingId === g.id}>
                      {deletingId === g.id ? "删除中…" : "删除"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </main>
  );
}
