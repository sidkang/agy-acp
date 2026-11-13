import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDescriptor } from "../types";
import {
  execAgyBounded,
  readStoredAgyOAuthCredentials,
  redactSecrets,
} from "../accounts/env";
import { combineSignals } from "../accounts/auth";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface QuotaWindow {
  name: string;
  /** Magpie host.js bucket pool: "Gemini" or "Claude & GPT". */
  pool: string;
  aside: boolean;
  used: number | null;
  display?: string;
  span?: number;
  resetsAt?: string;
  models?: string[];
}

export interface AccountUsageResult {
  plan?: string;
  windows: QuotaWindow[];
  signIn: "kept" | "expired";
  error?: string;
}

const GOOGLE_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_LOAD_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const PLAN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (matches official antigravity TIERS_TTL)
const PLAN_FETCH_TIMEOUT_MS = 5_000;

function platformTag(): string {
  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };
  return `${osMap[process.platform] ?? process.platform}/${archMap[process.arch] ?? process.arch}`;
}

/**
 * Formats a human-readable subscription plan badge (including 5x / 20x tier
 * multipliers when present) from a `loadCodeAssist` or usage tier payload.
 */
export function formatCodeAssistPlan(load: unknown): string | undefined {
  if (!load || typeof load !== "object") return undefined;
  const obj = load as Record<string, any>;
  const paid =
    obj.paidTier && typeof obj.paidTier === "object" ? obj.paidTier : undefined;
  const current =
    obj.currentTier && typeof obj.currentTier === "object"
      ? obj.currentTier
      : undefined;
  const primary = paid?.name || paid?.id ? paid : current;
  if (!primary) return undefined;

  const rawId = typeof primary.id === "string" ? primary.id.trim() : "";
  const rawName = typeof primary.name === "string" ? primary.name.trim() : "";
  const rawDesc =
    typeof primary.description === "string" ? primary.description.trim() : "";
  const rateLimitTier =
    typeof obj.rateLimitTier === "string" ? obj.rateLimitTier.trim() : "";

  let label = rawName;
  if (!paid) {
    if (/^(?:free-tier|legacy-tier|free)$/i.test(rawId)) {
      label = "Free";
    } else if (/^standard-tier$/i.test(rawId) && /^antigravity$/i.test(rawName)) {
      label = "Standard";
    }
  }
  if (!label) {
    if (/^g1-ultra-tier$/i.test(rawId)) label = "Google AI Ultra";
    else if (/^g1-pro-tier$/i.test(rawId)) label = "Google AI Pro";
    else if (/max[_-]?20x/i.test(rawId)) label = "Max 20x";
    else if (/max[_-]?5x/i.test(rawId)) label = "Max 5x";
    else label = rawId;
  }
  if (!label) return undefined;

  // Preserve explicit tier multipliers (e.g. 5x / 20x) when encoded in tier IDs
  // or rate-limit tier metadata without already appearing in the display name.
  if (!/\b\d+x\b/i.test(label)) {
    const multSource = `${rawId} ${rateLimitTier} ${rawDesc}`;
    const multMatch = /(?:^|[_-\s(])(5x|20x|\d+x)(?:$|[_-\s)])/i.exec(multSource);
    if (multMatch?.[1]) {
      const mult = multMatch[1].toLowerCase();
      if (/^max$/i.test(label)) {
        label = `Max ${mult}`;
      } else {
        label = `${label} ${mult}`;
      }
    }
  }

  return label || undefined;
}

interface PlanCacheEntry {
  timestamp: number;
  plan?: string;
  inFlight?: Promise<string | undefined>;
}

const planCache = new Map<string, PlanCacheEntry>();
const refreshedTokenCache = new Map<
  string,
  { accessToken: string; expiresAtMs: number }
>();

async function fetchCodeAssistPayload(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: any }> {
  const combined = combineSignals(signal, PLAN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CODE_ASSIST_LOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `antigravity/hub/1.21.9 ${platformTag()}`,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: combined.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  } finally {
    combined.dispose();
  }
}

async function refreshAccessTokenForPlan(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  pruneQuotaCaches(Date.now());
  const cached = refreshedTokenCache.get(refreshToken);
  if (cached && cached.expiresAtMs - Date.now() > 2 * 60 * 1000) {
    return cached.accessToken;
  }
  const combined = combineSignals(signal, PLAN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
      }).toString(),
      signal: combined.signal,
    });
    if (!res.ok) return undefined;
    const parsed: any = await res.json();
    const accessToken =
      typeof parsed?.access_token === "string" ? parsed.access_token.trim() : "";
    if (!accessToken) return undefined;
    const expiresInSec = Number(parsed?.expires_in) || 3600;
    refreshedTokenCache.set(refreshToken, {
      accessToken,
      expiresAtMs: Date.now() + expiresInSec * 1000,
    });
    pruneQuotaCaches(Date.now());
    return accessToken;
  } finally {
    combined.dispose();
  }
}

/**
 * Queries and caches (1h TTL) the account's subscription plan badge via
 * `v1internal:loadCodeAssist` when file-backed OAuth credentials are present.
 * Never throws; returns `undefined` if credentials are unavailable or offline.
 */
export async function queryAccountPlan(
  account: AccountDescriptor,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const key = `${account.accountRef}::${account.slotKey}`;
  const now = Date.now();
  pruneQuotaCaches(now);
  const existing = planCache.get(key);
  if (existing?.plan && now - existing.timestamp < PLAN_CACHE_TTL_MS) {
    return existing.plan;
  }
  if (existing?.inFlight) {
    return await existing.inFlight;
  }

  const creds = readStoredAgyOAuthCredentials(account);
  if (!creds) return undefined;

  const task = (async (): Promise<string | undefined> => {
    try {
      const nowMs = Date.now();
      let tok =
        creds.accessToken &&
        creds.expiresAtMs &&
        creds.expiresAtMs - nowMs > 2 * 60 * 1000
          ? creds.accessToken
          : undefined;

      if (tok) {
        const first = await fetchCodeAssistPayload(tok, signal);
        if (first.status === 200 && first.body) {
          const plan = formatCodeAssistPlan(first.body);
          if (plan) return plan;
        }
      }

      if (creds.refreshToken) {
        const refreshed = await refreshAccessTokenForPlan(
          creds.refreshToken,
          signal,
        );
        if (refreshed) {
          const second = await fetchCodeAssistPayload(refreshed, signal);
          if (second.status === 200 && second.body) {
            return formatCodeAssistPlan(second.body);
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  })();

  const entry: PlanCacheEntry = { timestamp: now, inFlight: task };
  planCache.set(key, entry);
  try {
    const plan = await task;
    if (plan) {
      entry.plan = plan;
      entry.timestamp = Date.now();
    } else if (planCache.get(key) === entry) {
      planCache.delete(key);
    }
    return plan;
  } finally {
    delete entry.inFlight;
    // Trim once the entry is settled so the map never rests above its cap.
    pruneQuotaCaches(Date.now());
  }
}

/**
 * Parses reset time into an ISO 8601 string.
 * Supports Unix timestamp in seconds, milliseconds, or ISO string.
 */
export function parseResetTime(value: unknown): string | undefined {
  if (value == null || value === "" || typeof value === "boolean") return undefined;
  const raw = String(value);
  let ms: number | undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    ms = Number(raw) * (Number(raw) < 1e11 ? 1000 : 1);
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    ms = Date.parse(raw);
  }
  if (!ms || !Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Detects whether an error message indicates an expired or missing login.
 */
export function isAuthExpirationError(text: string): boolean {
  return /not (?:logged|signed) in|unauthenticated|authentication (?:required|expired)|login required|please (?:log|sign) in|sign in again/i.test(
    text
  );
}

/**
 * Computes window cadence and period span.
 */
export function cadence(
  bucket: Record<string, unknown>,
  id: string,
  name: string
): { name: string; span?: number } {
  const windowStr = typeof bucket["window"] === "string" ? bucket["window"].trim() : "";
  const value = windowStr || `${id} ${name}`;

  if (
    /^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(value) ||
    (!windowStr && /(?:5h|five[ _-]hour|session)/i.test(value))
  ) {
    return { name: "5 hours", span: 5 * 60 * 60 };
  }

  if (
    /^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(value) ||
    (!windowStr && /(?:weekly|week|7d)/i.test(value))
  ) {
    return { name: "7 days", span: 7 * 24 * 60 * 60 };
  }

  return { name: name || id };
}

function extractRemainingFraction(bucket: Record<string, unknown>): number | undefined {
  const remaining = bucket["remaining"] as Record<string, unknown> | undefined;
  const fraction =
    bucket["remaining_fraction"] ??
    bucket["remainingFraction"] ??
    remaining?.["remaining_fraction"] ??
    remaining?.["remainingFraction"] ??
    (remaining?.["case"] === "remainingFraction" ? remaining["value"] : undefined);

  if (typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
    return fraction;
  }
  return undefined;
}

export interface ParseUsageOptions {
  quotaRouting?: boolean;
}

/**
 * Parses raw JSON / object report from `agy -p /usage --output-format json`.
 */
export function parseUsageReport(
  value: unknown,
  catalogModelIds: string[] = [],
  options: ParseUsageOptions = {}
): { windows: QuotaWindow[]; plan?: string } {
  let report: any;
  try {
    report = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new UsageError("agy returned an invalid usage report (invalid JSON).");
  }

  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    const errText = `${report?.error ?? ""} ${report?.response ?? ""}`.trim();
    if (isAuthExpirationError(errText)) {
      throw new UsageError("agy usage needs authentication. Run agy to sign in again.");
    }
    throw new UsageError(
      redactSecrets(errText) || "agy usage command did not return SUCCESS status."
    );
  }

  const dataObj = report?.command?.data;
  const groups = dataObj?.groups;
  if (!Array.isArray(groups)) {
    throw new UsageError("Limits not available: agy returned no quota groups.");
  }
  const inlinePlan =
    (typeof dataObj?.plan === "string" && dataObj.plan.trim()) ||
    formatCodeAssistPlan(dataObj);

  const windows: QuotaWindow[] = [];
  const quotaRouting = Boolean(options.quotaRouting);

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const rawName = String(
      group["displayName"] || group["display_name"] || group["name"] || "Quota"
    ).trim();
    const pool = rawName.replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ");
    const poolLower = pool.toLowerCase();
    // host.js expects a stable pool label, not the raw group display name.
    const windowPool = poolLower.includes("gemini")
      ? "Gemini"
      : poolLower.includes("claude") || poolLower.includes("gpt")
        ? "Claude & GPT"
        : pool;

    const buckets = group["buckets"];
    if (!Array.isArray(buckets)) continue;

    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const id = String(
        bucket["bucketId"] || bucket["bucket_id"] || bucket["id"] || ""
      ).trim();
      if (!id || bucket["disabled"] === true) continue;

      const label = String(
        bucket["displayName"] || bucket["display_name"] || bucket["name"] || id
      ).trim();
      const period = cadence(bucket, id, label);
      const fraction = extractRemainingFraction(bucket);
      const resetsAt = parseResetTime(bucket["reset_time"] ?? bucket["resetTime"]);

      // Models scoping
      let matchedModels: string[];
      if (poolLower.includes("gemini")) {
        matchedModels = catalogModelIds.filter((m) => /^gemini-/i.test(m));
      } else if (poolLower.includes("claude") || poolLower.includes("gpt")) {
        matchedModels = catalogModelIds.filter((m) => /^(?:claude|gpt)-/i.test(m));
      } else {
        matchedModels = catalogModelIds.filter((m) => m.toLowerCase().includes(poolLower));
      }

      const windowName = windowPool ? period.name : `${pool} · ${period.name}`;
      // Unknown quota stays unmeasurable and aside: Magpie must never read it as
      // "0% used" and route turns into an unknown bucket.
      const used =
        fraction === undefined
          ? null
          : fraction <= 0
            ? 100
            : Math.min(99.9, Math.max(0, Math.round((1 - fraction) * 100 * 10) / 10));
      // A pool with no catalog model to gate can never be an account-wide
      // routing block: Magpie would otherwise mark every model exhausted.
      const aside = used === null || !quotaRouting || matchedModels.length === 0;

      windows.push({
        name: windowName,
        pool: windowPool,
        aside,
        used,
        ...(used === null ? { display: "Limits not available" } : {}),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        ...(matchedModels.length > 0 ? { models: matchedModels } : {}),
      });
    }
  }

  if (windows.length === 0 || !windows.some((w) => w.used !== null)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.");
  }

  return {
    windows,
    ...(inlinePlan ? { plan: inlinePlan } : {}),
  };
}

interface CacheEntry {
  timestamp: number;
  inFlight?: Promise<AccountUsageResult>;
  data?: AccountUsageResult;
}

const usageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

/** Upper bound on retained cache entries; long-lived gateways see many slots. */
const MAX_USAGE_CACHE_ENTRIES = 128;

/**
 * Lazily drops expired cache entries before each use so a gateway process that
 * has seen many re-authenticated slots cannot grow these maps without bound.
 * In-flight work is never evicted: it would strand its promise.
 */
function pruneQuotaCaches(now: number): void {
  for (const [key, entry] of Array.from(usageCache)) {
    if (entry.inFlight) continue;
    if (!entry.data || now - entry.timestamp >= CACHE_TTL_MS) {
      usageCache.delete(key);
    }
  }
  evictOldestEntries(usageCache, (entry) => !entry.inFlight, (entry) =>
    entry.inFlight ? Number.POSITIVE_INFINITY : entry.timestamp,
  );

  for (const [key, entry] of Array.from(planCache)) {
    if (entry.inFlight) continue;
    if (now - entry.timestamp >= PLAN_CACHE_TTL_MS) {
      planCache.delete(key);
    }
  }
  evictOldestEntries(planCache, (entry) => !entry.inFlight, (entry) =>
    entry.inFlight ? Number.POSITIVE_INFINITY : entry.timestamp,
  );

  for (const [key, entry] of Array.from(refreshedTokenCache)) {
    if (entry.expiresAtMs - now <= 2 * 60 * 1000) {
      refreshedTokenCache.delete(key);
    }
  }
  evictOldestEntries(refreshedTokenCache, () => true, (entry) =>
    entry.expiresAtMs,
  );
}

/**
 * Trims `map` down to `MAX_USAGE_CACHE_ENTRIES`, always evicting the lowest
 * ranked (oldest) entry first and never touching an entry `evictable` rejects
 * (in-flight work). Exported for the cache-bound unit test.
 */
export function evictOldestEntries<T>(
  map: Map<string, T>,
  evictable: (entry: T) => boolean,
  rank: (entry: T) => number,
): void {
  while (map.size > MAX_USAGE_CACHE_ENTRIES) {
    let victimKey: string | undefined;
    let victimRank = Number.POSITIVE_INFINITY;
    for (const [key, entry] of map) {
      if (!evictable(entry)) continue;
      const value = rank(entry);
      if (value < victimRank) {
        victimRank = value;
        victimKey = key;
      }
    }
    if (victimKey === undefined) return;
    map.delete(victimKey);
  }
}

/** Test-only introspection: sizes are public metadata, never credential data. */
export function __getQuotaCacheStatsForTest(): {
  usageCacheSize: number;
  planCacheSize: number;
  refreshedTokenCacheSize: number;
} {
  return {
    usageCacheSize: usageCache.size,
    planCacheSize: planCache.size,
    refreshedTokenCacheSize: refreshedTokenCache.size,
  };
}

const activeUsageTempDirs = new Set<string>();
let usageExitHookRegistered = false;

function ensureUsageExitHookOnce(): void {
  if (usageExitHookRegistered) return;
  usageExitHookRegistered = true;
  process.once("exit", () => {
    for (const dir of Array.from(activeUsageTempDirs)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    activeUsageTempDirs.clear();
  });
}

/**
 * Only a measured, signed-in result is worth replaying. An `expired` or
 * transient failure must be retried on the next call so a fresh sign-in (or a
 * recovered CLI) is visible immediately instead of after 30s.
 */
function isCacheableUsageResult(result: AccountUsageResult): boolean {
  return result.signIn === "kept" && result.error === undefined && result.windows.length > 0;
}

/**
 * Queries account usage from `agy -p /usage --output-format json`.
 * Single-flights concurrent queries and caches successful measured results for 30s.
 */
export async function queryAccountUsage(
  account: AccountDescriptor,
  catalogModelIds: string[],
  options: { quotaRouting: boolean; signal?: AbortSignal }
): Promise<AccountUsageResult> {
  // Scope by account identity *and* slot: a re-authenticated slot gets a new
  // accountRef, and two descriptors must never share cached quota/expiry state.
  const cacheScopeKey = `${account.accountRef}::${account.slotKey}`;
  const cacheKey = `${cacheScopeKey}:${options.quotaRouting}`;
  const now = Date.now();
  pruneQuotaCaches(now);
  const cached = usageCache.get(cacheKey);

  if (cached?.data && now - cached.timestamp < CACHE_TTL_MS) {
    return structuredClone(cached.data);
  }

  if (cached?.inFlight) {
    return await cached.inFlight;
  }

  const queryPromise = (async (): Promise<AccountUsageResult> => {
    const tempRoot = os.tmpdir();
    let tempDir: string | undefined;

    try {
      tempDir = fs.mkdtempSync(path.join(tempRoot, "magpie-agy-usage-"));
      activeUsageTempDirs.add(tempDir);
      ensureUsageExitHookOnce();
      try {
        fs.chmodSync(tempDir, 0o700);
      } catch {}

      const [res, lookedUpPlan] = await Promise.all([
        execAgyBounded(
          account,
          ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"],
          {
            cwd: tempDir,
            timeoutMs: 15_000,
            signal: options.signal,
          }
        ),
        queryAccountPlan(account, options.signal),
      ]);

      const allOutput = `${res.stdout}\n${res.stderr}`.trim();

      if (isAuthExpirationError(allOutput)) {
        return {
          windows: [],
          signIn: "expired",
          error: "Antigravity CLI authentication expired or not logged in.",
        };
      }

      if (res.exitCode !== 0 || !res.stdout.trim()) {
        return {
          ...(lookedUpPlan ? { plan: lookedUpPlan } : {}),
          windows: [],
          signIn: "kept",
          error: redactSecrets(
            `agy usage query failed: exitCode=${res.exitCode} ${res.stderr || res.stdout}`.trim()
          ),
        };
      }

      try {
        const { windows, plan: reportPlan } = parseUsageReport(
          res.stdout,
          catalogModelIds,
          {
            quotaRouting: options.quotaRouting,
          },
        );
        const finalPlan = lookedUpPlan || reportPlan;
        return {
          ...(finalPlan ? { plan: finalPlan } : {}),
          windows,
          signIn: "kept",
        };
      } catch (err: any) {
        if (isAuthExpirationError(err.message)) {
          return {
            windows: [],
            signIn: "expired",
            error: err.message,
          };
        }
        return {
          windows: [],
          signIn: "kept",
          error: redactSecrets(err.message || "Failed to parse usage report."),
        };
      }
    } finally {
      if (tempDir) {
        activeUsageTempDirs.delete(tempDir);
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  })();

  const entry: CacheEntry = {
    timestamp: now,
    inFlight: queryPromise,
  };
  usageCache.set(cacheKey, entry);

  try {
    const result = await queryPromise;
    if (isCacheableUsageResult(result)) {
      entry.data = result;
      entry.timestamp = Date.now();
    }
    return result;
  } finally {
    delete entry.inFlight;
    // Failures are never replayed: drop the entry so the next call re-queries.
    if (!entry.data && usageCache.get(cacheKey) === entry) {
      usageCache.delete(cacheKey);
    }
    // Trim once the entry is settled so the map never rests above its cap.
    pruneQuotaCaches(Date.now());
  }
}
