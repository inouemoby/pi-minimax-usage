import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

// ─── Constants ───────────────────────────────────────────────────
// MiniMax Token Plan "Coding Plan remains" endpoint — also called by CodexBar
// and OmniRoute. The endpoint is the same path on both regions, only the host differs.
const URL_INTL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const URL_CN = "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const CACHE_MS = 60_000;

// API status codes returned in `base_resp.status_code` (well-known subset).
const STATUS_OK = 0;
const STATUS_INACTIVE = 2062; // "no active token plan subscription"
const STATUS_BAD_KEY = 1004; // region/auth mismatch
const STATUS_INVALID_KEY = 2049; // invalid api key
const STATUS_WRONG_KEY = 2057; // "not token plan token"

// ─── Types ───────────────────────────────────────────────────────
interface ModelRemains {
  model_name?: string;
  // 5h rolling window
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  remains_time?: number; // ms until reset (5h)
  end_time?: number;     // epoch ms (5h)
  // weekly window
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_remains_time?: number; // ms until reset (weekly)
  weekly_end_time?: number;     // epoch ms (weekly)
}

interface CodingPlanResp {
  model_remains?: ModelRemains[] | null;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface QuotaSnapshot {
  total: number;
  used: number;
  remain: number;
  resetMs: number | null;
  unlimited: boolean;
}

interface UsageData {
  apiKey: string;
  region: "intl" | "cn";
  ok: boolean;
  message: string;
  // null when the plan is inactive, the response is malformed, or no quota models exist.
  session: QuotaSnapshot | null; // 5h rolling
  weekly: QuotaSnapshot | null;  // weekly quota
  _ts: number;
}

// ─── Helpers ─────────────────────────────────────────────────────
function getApiKeys(): { intl: string; cn: string } {
  const intlKey = process.env.MINIMAX_API_KEY ?? "";
  let intl = intlKey;
  let cn = "";
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf-8"),
    ) as Record<string, any>;
    if (!intl && typeof auth["minimax"]?.key === "string") intl = auth["minimax"].key;
    if (typeof auth["minimax-cn"]?.key === "string") cn = auth["minimax-cn"].key;
  } catch {
    /* ignore */
  }
  return { intl, cn };
}

function pickRegion(ctx: any): "intl" | "cn" | null {
  const p = ctx?.model?.provider;
  if (p === "minimax-cn") return "cn";
  if (p === "minimax") return "intl";
  return null;
}

function pickKey(region: "intl" | "cn", keys: { intl: string; cn: string }): string {
  return region === "cn" ? keys.cn : keys.intl;
}

function num(v: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function isQuotaModel(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const s = name.trim().toLowerCase();
  return s.startsWith("minimax-m") || s.startsWith("coding-plan");
}

function makeSnapshot(total: number, used: number, resetMs: number | null): QuotaSnapshot {
  const safeTotal = Math.max(0, total);
  const safeUsed = safeTotal > 0 ? Math.min(Math.max(0, used), safeTotal) : 0;
  return {
    total: safeTotal,
    used: safeUsed,
    remain: Math.max(safeTotal - safeUsed, 0),
    resetMs: resetMs ?? null,
    unlimited: safeTotal <= 0,
  };
}

function sessionTotal(m: ModelRemains): number {
  return Math.max(0, num(m.current_interval_total_count));
}
function weeklyTotal(m: ModelRemains): number {
  return Math.max(0, num(m.current_weekly_total_count));
}

function pickRepModel(
  models: ModelRemains[],
  getTotal: (m: ModelRemains) => number,
): ModelRemains | null {
  if (models.length === 0) return null;
  // Prefer entries with a positive total — falling back to first model when all are 0.
  const withQuota = models.filter((m) => getTotal(m) > 0);
  const pool = withQuota.length > 0 ? withQuota : models;
  return pool.reduce((best, cur) => (getTotal(cur) > getTotal(best) ? cur : best));
}

function resetMsFrom(model: ModelRemains, capturedAtMs: number,
                     remainsKey: "remains_time" | "weekly_remains_time",
                     endKey: "end_time" | "weekly_end_time"): number | null {
  const rem = num(model[remainsKey]);
  if (rem > 0) return capturedAtMs + rem;
  const end = num(model[endKey]);
  if (end > 0) return end;
  return null;
}

// ─── Fetch ───────────────────────────────────────────────────────
async function fetchQuota(apiKey: string, region: "intl" | "cn"): Promise<UsageData> {
  const url = region === "cn" ? URL_CN : URL_INTL;
  const capturedAt = Date.now();
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const raw = await r.text();
  let json: CodingPlanResp = {};
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${r.status} (non-JSON)`);
  }
  const status = num(json.base_resp?.status_code);
  const msg = (json.base_resp?.status_msg ?? "").toString();

  if (status === STATUS_INACTIVE) {
    return { apiKey, region, ok: false, message: msg || "no active token plan subscription",
             session: null, weekly: null, _ts: capturedAt };
  }
  if (status === STATUS_BAD_KEY || status === STATUS_INVALID_KEY || status === STATUS_WRONG_KEY) {
    throw new Error(`auth error ${status}: ${msg}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${msg || raw.slice(0, 120)}`);

  const arr = Array.isArray(json.model_remains) ? json.model_remains : [];
  const textModels = arr.filter((m) => isQuotaModel(m.model_name));
  if (textModels.length === 0) {
    return { apiKey, region, ok: false, message: "MiniMax connected. No text quota data was returned.",
             session: null, weekly: null, _ts: capturedAt };
  }
  const sessionModel = pickRepModel(textModels, sessionTotal);
  const weeklyModel = pickRepModel(textModels, weeklyTotal);

  const session = sessionModel
    ? makeSnapshot(sessionTotal(sessionModel),
                   Math.max(0, num(sessionModel.current_interval_usage_count)),
                   sessionModel ? resetMsFrom(sessionModel, capturedAt, "remains_time", "end_time") : null)
    : null;
  const weekly = weeklyModel && weeklyTotal(weeklyModel) > 0
    ? makeSnapshot(weeklyTotal(weeklyModel),
                   Math.max(0, num(weeklyModel.current_weekly_usage_count)),
                   weeklyModel ? resetMsFrom(weeklyModel, capturedAt, "weekly_remains_time", "weekly_end_time") : null)
    : null;

  return { apiKey, region, ok: true, message: "", session, weekly, _ts: capturedAt };
}

// ─── Footer formatting ───────────────────────────────────────────
function formatPercent(used: number, total: number): string {
  if (total <= 0) return "?";
  const p = (used / total) * 100;
  return p < 10 ? p.toFixed(1) : Math.round(p).toString();
}

function formatRemainTime(ms: number | null): string {
  if (!ms || ms <= 0) return "?";
  const diff = Math.max(0, ms - Date.now());
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h${m}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d` : `${d}d${rh}h`;
}

function severity(p: number, ok: boolean): number {
  if (!ok) return 2;
  if (p >= 90) return 2;
  if (p >= 70) return 1;
  return 0;
}

function formatReset(usage: UsageData): string {
  const parts: string[] = [];
  if (usage.session) {
    const p = usage.session.total > 0 ? (usage.session.used / usage.session.total) * 100 : 0;
    const s = severity(p, true);
    const flag = s === 2 ? "!!" : s === 1 ? "!" : "";
    parts.push(`${flag}5h:${Math.round(p)}% ${formatRemainTime(usage.session.resetMs)}`);
  }
  if (usage.weekly) {
    const p = usage.weekly.total > 0 ? (usage.weekly.used / usage.weekly.total) * 100 : 0;
    const s = severity(p, true);
    const flag = s === 2 ? "!!" : s === 1 ? "!" : "";
    parts.push(`${flag}wk:${Math.round(p)}% ${formatRemainTime(usage.weekly.resetMs)}`);
  }
  if (parts.length === 0) {
    return usage.ok ? "MiniMax ready" : `MiniMax ${usage.message}`;
  }
  return parts.join(" ");
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

// ─── Main ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const keys = getApiKeys();
  let usageByRegion: Record<"intl" | "cn", UsageData | null> = { intl: null, cn: null };
  let footerOn = false;
  let footerGeneration = 0;
  let _tui: any = null;
  let thinkingLevel = "off";
  const IDLE_REFRESH_MS = 30 * 60 * 1000;  // 闲时定时刷新: 30 分钟
  let latestCtx: any = null;              // 最近一次事件拿到的 ctx,供定时器使用
  let agentBusy = false;                  // agent 生成中 = true,定时刷新只在闲时执行
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  async function getUsage(region: "intl" | "cn"): Promise<UsageData> {
    const key = pickKey(region, keys);
    if (!key) throw new Error(`MiniMax ${region === "cn" ? "China" : "international"} API key not found in auth.json`);
    const cached = usageByRegion[region];
    if (cached && Date.now() - cached._ts < CACHE_MS) return cached;
    const fresh = await fetchQuota(key, region);
    usageByRegion[region] = fresh;
    return fresh;
  }

  function isMiniMax(ctx: any): boolean {
    return ctx?.model?.provider === "minimax" || ctx?.model?.provider === "minimax-cn";
  }
  function requestRenderSafe(tui: any): void {
    try { tui?.requestRender?.(); } catch { /* footer may already be disposed */ }
  }

  function trigger() {
    setTimeout(() => requestRenderSafe(_tui), 0);
  }

  async function refresh(ctx: any) {
    const region = pickRegion(ctx);
    if (!region) return;
    try {
      await getUsage(region);
      trigger();
    } catch {
      /* silent — leave footer to render an empty state */
    }
  }

  function toggleFooter(ctx: any, force = false) {
    if (isMiniMax(ctx)) {
      if (!footerOn || force) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else if (footerOn) {
      _tui = null;
      ctx.ui.setFooter(undefined as any);
      footerOn = false;
    }
  }

  function buildFooter(ctx: any) {
    const generation = ++footerGeneration;
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => {
        if (generation === footerGeneration) requestRenderSafe(tui);
      });
      return {
        dispose: () => {
          try { unsub(); } catch { /* already disposed */ }
          if (generation === footerGeneration) {
            _tui = null;
            footerOn = false;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;
          // ── Line 1: cwd ─────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ───────────────────────────────
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost.total;
            }
          }
          const parts: string[] = [];
          const cachePartIndexes: number[] = [];
          const tokenPartIndexes: number[] = [];
          let costPartIndex = -1;
          if (ti) { tokenPartIndexes.push(parts.length); parts.push(`↑${formatTokens(ti)}`); }
          if (to) { tokenPartIndexes.push(parts.length); parts.push(`↓${formatTokens(to)}`); }
          if (tr) { cachePartIndexes.push(parts.length); parts.push(`R${formatTokens(tr)}`); }
          if (tw) { cachePartIndexes.push(parts.length); parts.push(`W${formatTokens(tw)}`); }
          if (tc) { costPartIndex = parts.length; parts.push(`$${tc.toFixed(3)}`); }

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // MiniMax quota (only when active region)
          const region = pickRegion(ctx);
          if (region) {
            const usage = usageByRegion[region];
            if (usage) parts.push(formatReset(usage));
          }

          let left = parts.join(" ");
          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          const providerLabel = m?.provider === "minimax-cn" ? "(MiniMax CN)" : "(MiniMax)";
          const withProv = `${providerLabel} ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }

          // 宽度不足时的省略顺序 (与 pi-codex-usage 一致): 供应商名 → 缓存计数 → 费用 → 累计 token
          const fits = () => visibleWidth(left) + 2 + visibleWidth(right) <= width;
          if (!fits()) {
            for (const index of cachePartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && tokenPartIndexes.length > 0) {
            for (const index of tokenPartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  // ── Idle timer (每 30 分钟闲时刷新) ───────────────────────
  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(() => {
      if (agentBusy) return;                    // 生成中,跳过本轮
      const ctx = latestCtx;
      if (!ctx || !isMiniMax(ctx)) return;  // 只在对应 provider 下刷新
      refresh(ctx);
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();               // 不阻止进程退出
  }

  function stopIdleTimer() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;                            // 强制重建 footer,确保闭包捕获新 ctx
    toggleFooter(ctx, true);
    refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    stopIdleTimer();
    latestCtx = null;
  });

  pi.on("agent_start", async (_e, ctx) => { latestCtx = ctx; agentBusy = true; });
  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    refresh(ctx);
  });

  // 每条 assistant 消息结束 (含工具调用轮次) 都尝试刷新一次, 让单轮很长的任务
  // 中途也能及时看到用量变化; 同一个 CACHE_MS 窗口内最多发起一次 (含失败重试), 避免过快
  let lastMidRefreshAt = 0;
  pi.on("message_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (event?.message?.role !== "assistant") return;
    if (!isMiniMax(ctx)) return;
    const now = Date.now();
    if (now - lastMidRefreshAt < CACHE_MS) return;
    lastMidRefreshAt = now;
    refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isMiniMax(ctx)) {
      // 延迟到 macrotask: 让排在我们后面的扩展先完成卸载,我们再挂载,避免被覆盖
      setTimeout(() => {
        const currentCtx = latestCtx;
        if (!currentCtx || !isMiniMax(currentCtx)) return;
        try {
          toggleFooter(currentCtx, true);
          refresh(currentCtx);
        } catch { /* session or footer was disposed */ }
      }, 0);
    } else {
      // 切走时立即卸载自己,给目标 provider 的扩展让位
      toggleFooter(ctx);
      refresh(ctx);
    }
  });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event?.level || "off"; trigger(); });

  // ── /minimax ─────────────────────────────────────────────
  pi.registerCommand("minimax", {
    description: "Show MiniMax Token Plan (Coding Plan) quota",
    handler: async (_args, ctx) => {
      const region = pickRegion(ctx) ?? (keys.cn ? "cn" : "intl");
      try {
        const d = await getUsage(region);
        const lines: string[] = [`══ MiniMax Coding Plan (${region === "cn" ? "China" : "International"}) ══`];
        if (!d.ok) {
          lines.push(`Status: ${d.message}`);
        } else {
          if (d.session) {
            const p = d.session.total > 0 ? (d.session.used / d.session.total) * 100 : 0;
            lines.push(`5h:     ${formatPercent(d.session.used, d.session.total)}% / ${d.session.total} used, ${d.session.remain} left, reset in ${formatRemainTime(d.session.resetMs)}`);
          }
          if (d.weekly) {
            const p = d.weekly.total > 0 ? (d.weekly.used / d.weekly.total) * 100 : 0;
            lines.push(`Weekly: ${formatPercent(d.weekly.used, d.weekly.total)}% / ${d.weekly.total} used, ${d.weekly.remain} left, reset in ${formatRemainTime(d.weekly.resetMs)}`);
          }
          if (!d.session && !d.weekly) lines.push("No quota data was returned.");
        }
        ctx.ui.notify(lines.join("\n"), d.ok ? "info" : "warning");
      } catch (err: any) {
        ctx.ui.notify(`MiniMax: ${err.message}`, "error");
      }
    },
  });
}