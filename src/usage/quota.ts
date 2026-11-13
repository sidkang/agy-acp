import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDescriptor } from "../types";
import { execAgyBounded, redactSecrets } from "../accounts/env";

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
  windows: QuotaWindow[];
  signIn: "kept" | "expired";
  error?: string;
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
): { windows: QuotaWindow[] } {
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

  const groups = report?.command?.data?.groups;
  if (!Array.isArray(groups)) {
    throw new UsageError("Limits not available: agy returned no quota groups.");
  }

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
      const isKnown = fraction !== undefined;
      const resetsAt = parseResetTime(bucket["reset_time"] ?? bucket["resetTime"]);

      // Models scoping
      let matchedModels: string[] | undefined;
      if (poolLower.includes("gemini")) {
        matchedModels = catalogModelIds.filter((m) => /^gemini-/i.test(m));
      } else if (poolLower.includes("claude") || poolLower.includes("gpt")) {
        matchedModels = catalogModelIds.filter((m) => /^(?:claude|gpt)-/i.test(m));
      } else {
        matchedModels = catalogModelIds.filter((m) => m.toLowerCase().includes(poolLower));
      }

      const windowName = windowPool ? period.name : `${pool} · ${period.name}`;
      // A pool with no catalog model to gate can never be an account-wide
      // routing block: Magpie would otherwise mark every model exhausted.
      const aside = !quotaRouting || !matchedModels || matchedModels.length === 0;
      if (isKnown) {
        const rawUsed = (1 - fraction!) * 100;
        const used =
          fraction! <= 0
            ? 100
            : Math.min(99.9, Math.max(0, Math.round(rawUsed * 10) / 10));
        windows.push({
          name: windowName,
          pool: windowPool,
          aside,
          used,
          ...(period.span ? { span: period.span } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          ...(matchedModels && matchedModels.length > 0 ? { models: matchedModels } : {}),
        });
      } else {
        windows.push({
          name: windowName,
          pool: windowPool,
          aside: true,
          used: null,
          display: "Limits not available",
          ...(period.span ? { span: period.span } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          ...(matchedModels && matchedModels.length > 0 ? { models: matchedModels } : {}),
        });
      }
    }
  }

  if (windows.length === 0 || !windows.some((w) => w.used !== null)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.");
  }

  return { windows };
}

interface CacheEntry {
  timestamp: number;
  inFlight?: Promise<AccountUsageResult>;
  data?: AccountUsageResult;
}

const usageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

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
      try {
        fs.chmodSync(tempDir, 0o700);
      } catch {}

      const res = await execAgyBounded(
        account,
        ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"],
        {
          cwd: tempDir,
          timeoutMs: 15_000,
          signal: options.signal,
        }
      );

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
          windows: [],
          signIn: "kept",
          error: redactSecrets(
            `agy usage query failed: exitCode=${res.exitCode} ${res.stderr || res.stdout}`.trim()
          ),
        };
      }

      try {
        const { windows } = parseUsageReport(res.stdout, catalogModelIds, {
          quotaRouting: options.quotaRouting,
        });
        return {
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
  }
}
