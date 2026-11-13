import type { AccountDescriptor, EffortLevel, OfferedModelVariant } from "../types";
import { execAgyBounded } from "../accounts/env";

export const EFFORT_ORDER: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i;

export interface RawModelEntry {
  rawModelId: string;
  displayName: string;
}

export interface CatalogFamilyRoute {
  readonly familyId: string;
  readonly displayName: string;
  readonly defaultEffort: EffortLevel;
  readonly efforts: EffortLevel[];
  readonly byEffort: Map<EffortLevel, string>;
  readonly configModelValue: string;
}

export interface CatalogModelItem {
  id: string;
  name: string;
  variants?: EffortLevel[];
}

export interface AccountCatalog {
  readonly models: CatalogModelItem[];
  readonly routes: Map<string, CatalogFamilyRoute>;
  readonly rawIds: Set<string>;
  readonly variants: Map<string, OfferedModelVariant>;
  readonly fetchedAt: number;
  readonly isFallback: boolean;
}

export interface MagpieModelMetadata {
  id: string;
  name: string;
  npm: string;
  limit?: { context: number; output: number };
  api: { id: string; url: string; npm: string };
  capabilities: {
    attachment?: boolean;
    input?: { text: boolean; image: boolean };
    output?: { text: boolean };
    reasoning?: boolean;
  };
  reasoning?: boolean;
  variants?: Record<string, Record<string, never>>;
}

// Keep the emergency catalog in step with the known CLI families. A fresh
// account's first probe may exceed the fast-wait budget; omitting a known
// family here makes Magpie mark that account `unlisted` and skip failover.
export const STATIC_FALLBACK_MODELS: RawModelEntry[] = [
  { rawModelId: "gemini-4-carbon-high", displayName: "Gemini 4 Carbon (High)" },
  { rawModelId: "gemini-4-carbon-medium", displayName: "Gemini 4 Carbon (Medium)" },
  { rawModelId: "gemini-4-carbon-low", displayName: "Gemini 4 Carbon (Low)" },
  { rawModelId: "gemini-4-hydrogen-xhigh", displayName: "Gemini 4 Hydrogen (XHigh)" },
  { rawModelId: "gemini-4-hydrogen-high", displayName: "Gemini 4 Hydrogen (High)" },
  { rawModelId: "gemini-4-hydrogen-medium", displayName: "Gemini 4 Hydrogen (Medium)" },
  { rawModelId: "gemini-4-hydrogen-low", displayName: "Gemini 4 Hydrogen (Low)" },
  { rawModelId: "gemini-pro-orchestrator", displayName: "Orchestrator (Carbon)" },
  { rawModelId: "gemini-pro-orchestrator-argon", displayName: "Orchestrator (Argon)" },
  { rawModelId: "gemini-4-argon-high", displayName: "Gemini 4 Argon (High)" },
  { rawModelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)" },
  { rawModelId: "gemini-4-argon-low", displayName: "Gemini 4 Argon (Low)" },
  { rawModelId: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" },
  { rawModelId: "gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)" },
  { rawModelId: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" },
  { rawModelId: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 (High)" },
  { rawModelId: "claude-opus-5-5-medium", displayName: "Claude Opus 5.5 (Medium)" },
  { rawModelId: "claude-opus-5-5-low", displayName: "Claude Opus 5.5 (Low)" },
  { rawModelId: "claude-sonnet-5-5-high", displayName: "Claude Sonnet 5.5 (High)" },
  { rawModelId: "claude-sonnet-5-5-medium", displayName: "Claude Sonnet 5.5 (Medium)" },
  { rawModelId: "claude-sonnet-5-5-low", displayName: "Claude Sonnet 5.5 (Low)" },
  { rawModelId: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)" },
];

/**
 * Parses raw `agy models` CLI output.
 * Lines are expected to be formatted as `<rawModelId>\t<Display Name>`.
 * Skips informational lines like "Fetching available models...".
 */
export function parseAgyModelsOutput(output: string): RawModelEntry[] {
  const lines = output.split(/\r?\n/);
  const result: RawModelEntry[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("Fetching available models")) continue;

    const match = /^([^\s]+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const rawModelId = match[1]!;
    const displayName = match[2]!.trim();
    result.push({ rawModelId, displayName });
  }

  return result;
}

/**
 * Returns model context and output token limits.
 */
export function getModelLimits(id: string): { context: number; output: number } | undefined {
  const family = id.replace(/\[1m\]$/i, "").replace(EFFORT_SUFFIX_RE, "");
  if (/^(?:gemini-4-argon|gemini-3\.8-flash|gemini-4-hydrogen)$/i.test(family)) {
    return { context: 1048576, output: 65536 };
  }
  if (/^gemini-4-carbon$/i.test(family)) {
    return { context: 1048576, output: 262144 };
  }
  if (/^claude-(?:opus|sonnet)-5-5$/i.test(family)) {
    return { context: 1000000, output: 64000 };
  }
  if (/^gpt-oss-120b$/i.test(family)) {
    return { context: 131072, output: 32768 };
  }
  return undefined;
}

/**
 * Finds the closest available effort level in EFFORT_ORDER.
 */
export function closestEffort(requested: EffortLevel, available: EffortLevel[]): EffortLevel {
  if (available.includes(requested)) return requested;
  const targetIdx = EFFORT_ORDER.indexOf(requested);
  let best = available[0]!;
  let bestDist = Math.abs(EFFORT_ORDER.indexOf(best) - targetIdx);
  for (let i = 1; i < available.length; i++) {
    const cand = available[i]!;
    const dist = Math.abs(EFFORT_ORDER.indexOf(cand) - targetIdx);
    if (dist < bestDist || (dist === bestDist && EFFORT_ORDER.indexOf(cand) > EFFORT_ORDER.indexOf(best))) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

export interface BuildCatalogOptions {
  availableModels?: Array<{ id: string; name?: string }>;
  configOptions?: any[];
  isFallback?: boolean;
}

/**
 * Builds an AccountCatalog from raw models.
 * Groups effort-suffixed models into family IDs with variants.
 * Handles gpt-oss-120b-medium by exposing both family and raw ID.
 */
export function buildCatalog(
  rawList: RawModelEntry[],
  options?: BuildCatalogOptions
): AccountCatalog {
  const rawIds = new Set<string>();
  const variantsMap = new Map<string, OfferedModelVariant>();
  const familiesMap = new Map<string, Array<{ rawModelId: string; displayName: string; effort: EffortLevel }>>();
  const standaloneList: RawModelEntry[] = [];

  for (const entry of rawList) {
    rawIds.add(entry.rawModelId);
    const match = EFFORT_SUFFIX_RE.exec(entry.rawModelId);
    if (match) {
      const effort = match[1]!.toLowerCase() as EffortLevel;
      const baseId = entry.rawModelId.slice(0, match.index);
      let list = familiesMap.get(baseId);
      if (!list) {
        list = [];
        familiesMap.set(baseId, list);
      }
      list.push({ rawModelId: entry.rawModelId, displayName: entry.displayName, effort });

      variantsMap.set(entry.rawModelId, {
        rawModelId: entry.rawModelId,
        familyId: baseId,
        displayName: entry.displayName,
        configModelValue: baseId,
        effort,
      });
    } else {
      standaloneList.push(entry);
      variantsMap.set(entry.rawModelId, {
        rawModelId: entry.rawModelId,
        familyId: entry.rawModelId,
        displayName: entry.displayName,
        configModelValue: entry.rawModelId,
      });
    }
  }

  const models: CatalogModelItem[] = [];
  const routes = new Map<string, CatalogFamilyRoute>();

  // Process grouped families
  for (const [familyId, variantItems] of familiesMap.entries()) {
    // A family needs at least 2 variants with distinct efforts unless it's gpt-oss-120b
    const effortsSet = new Set(variantItems.map((v) => v.effort));
    if (variantItems.length >= 2 && effortsSet.size === variantItems.length) {
      const sorted = [...variantItems].sort(
        (a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort)
      );
      const efforts = sorted.map((v) => v.effort);
      const byEffort = new Map<EffortLevel, string>(sorted.map((v) => [v.effort, v.rawModelId]));
      const defaultEffort: EffortLevel = byEffort.has("medium")
        ? "medium"
        : byEffort.has("high")
          ? "high"
          : efforts[efforts.length - 1]!;

      // Display name without effort suffix e.g. "Gemini 3.8 Flash"
      const defaultVariant = sorted.find((v) => v.effort === defaultEffort) ?? sorted[0]!;
      const cleanName = defaultVariant.displayName
        .replace(/\s+\((?:minimal|low|medium|high|xhigh|max)\)$/i, "")
        .trim();

      models.push({
        id: familyId,
        name: cleanName || familyId,
        variants: efforts,
      });

      routes.set(familyId, {
        familyId,
        displayName: cleanName || familyId,
        defaultEffort,
        efforts,
        byEffort,
        configModelValue: familyId,
      });
    } else if (familyId !== "gpt-oss-120b") {
      // Single variant that is not a multi-variant family
      for (const item of variantItems) {
        standaloneList.push({ rawModelId: item.rawModelId, displayName: item.displayName });
      }
    }
  }

  // Handle gpt-oss-120b-medium special case: expose collapsed family `gpt-oss-120b`
  // with `variants: ["medium"]`, while keeping `gpt-oss-120b-medium` resolvable via `variantsMap`.
  if (rawIds.has("gpt-oss-120b-medium")) {
    if (!routes.has("gpt-oss-120b")) {
      const byEffort = new Map<EffortLevel, string>([["medium", "gpt-oss-120b-medium"]]);
      models.push({
        id: "gpt-oss-120b",
        name: "GPT-OSS 120B",
        variants: ["medium"],
      });
      routes.set("gpt-oss-120b", {
        familyId: "gpt-oss-120b",
        displayName: "GPT-OSS 120B",
        defaultEffort: "medium",
        efforts: ["medium"],
        byEffort,
        configModelValue: "gpt-oss-120b",
      });
    }

    variantsMap.set("gpt-oss-120b", {
      rawModelId: "gpt-oss-120b-medium",
      familyId: "gpt-oss-120b",
      displayName: "GPT-OSS 120B",
      configModelValue: "gpt-oss-120b",
      effort: "medium",
    });
  }

  // Add standalone models
  for (const item of standaloneList) {
    if (!models.some((m) => m.id === item.rawModelId)) {
      models.push({
        id: item.rawModelId,
        name: item.displayName,
      });
    }
  }

  // Enrich with ACP availableModels or configOptions if provided
  if (options?.availableModels && options.availableModels.length > 0) {
    const offeredIds = new Set(options.availableModels.map((m) => m.id));
    for (const offered of options.availableModels) {
      if (!models.some((m) => m.id === offered.id) && !routes.has(offered.id)) {
        models.push({
          id: offered.id,
          name: offered.name || offered.id,
        });
      }
    }
  }

  return {
    models,
    routes,
    rawIds,
    variants: variantsMap,
    fetchedAt: Date.now(),
    isFallback: Boolean(options?.isFallback),
  };
}

/**
 * Builds Magpie `provider.models()` metadata map.
 */
export function buildProviderModels(
  catalog: AccountCatalog,
  options?: { includeRawIds?: boolean; fellBack?: boolean }
): Record<string, MagpieModelMetadata> {
  const result: Record<string, MagpieModelMetadata> = {};

  for (const model of catalog.models) {
    const isImage = /^(?:gemini-|claude-)/i.test(model.id);
    const hasVariants = Boolean(model.variants && model.variants.length > 0);
    const limit = getModelLimits(model.id);

    result[model.id] = {
      id: model.id,
      name: model.name,
      npm: "@ai-sdk/anthropic",
      ...(limit ? { limit } : {}),
      api: { id: model.id, url: "agy://local", npm: "@ai-sdk/anthropic" },
      capabilities: {
        ...(isImage ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
        ...(hasVariants ? { reasoning: true } : {}),
      },
      ...(hasVariants
        ? {
            reasoning: true,
            variants: Object.fromEntries(model.variants!.map((e) => [e, {}])),
          }
        : {}),
    };
  }

  if (options?.includeRawIds) {
    for (const rawId of catalog.rawIds) {
      if (!result[rawId]) {
        const variant = catalog.variants.get(rawId);
        const isImage = /^(?:gemini-|claude-)/i.test(rawId);
        const limit = getModelLimits(rawId);
        result[rawId] = {
          id: rawId,
          name: variant?.displayName || rawId,
          npm: "@ai-sdk/anthropic",
          ...(limit ? { limit } : {}),
          api: { id: rawId, url: "agy://local", npm: "@ai-sdk/anthropic" },
          capabilities: {
            ...(isImage ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
          },
        };
      }
    }
  }

  if (catalog.isFallback || options?.fellBack === true) {
    // Magpie (host.js) keeps the model list it already had when a provider says
    // it fell back, instead of replacing it with a transient fallback catalog.
    Object.defineProperty(result, Symbol.for("magpie.fellBack"), {
      value: true,
      enumerable: false,
    });
  }

  return result;
}

/**
 * Resolves a requested model name (family ID, raw ID, or alias) to underlying
 * rawModelId, configModelValue, and optional effort level.
 */
export function resolveRequestedModel(
  requestedModel: string,
  catalog: AccountCatalog,
  effortOverride?: EffortLevel
): { rawModelId: string; configModelValue: string; effort?: EffortLevel } | null {
  if (!requestedModel || typeof requestedModel !== "string") {
    return null;
  }

  const trimmed = requestedModel.trim();
  if (!trimmed) return null;

  // Check for inline effort syntax like "model:low"
  let modelName = trimmed;
  let inlineEffort: EffortLevel | undefined;
  if (modelName.includes(":")) {
    const [base, effortPart] = modelName.split(":");
    if (base && effortPart && EFFORT_ORDER.includes(effortPart.toLowerCase() as EffortLevel)) {
      modelName = base;
      inlineEffort = effortPart.toLowerCase() as EffortLevel;
    }
  }

  // Magpie appends `[1m]` to denote a 1M-context request; it is not part of
  // the agy model ID.
  modelName = modelName.replace(/\[1m\]$/i, "");

  // Strip trailing date suffixes like "-20241022" or "-20250514"
  const undated = modelName.replace(/-\d{8}$/, "");

  // Check if directly a family route
  const family = catalog.routes.get(undated) ?? catalog.routes.get(modelName);
  if (family) {
    const effort = effortOverride
      ? closestEffort(effortOverride, family.efforts)
      : inlineEffort
        ? closestEffort(inlineEffort, family.efforts)
        : family.defaultEffort;
    const rawModelId = family.byEffort.get(effort) ?? family.byEffort.get(family.defaultEffort)!;
    return {
      rawModelId,
      configModelValue: family.configModelValue,
      effort,
    };
  }

  // Check if directly a known raw ID
  if (catalog.rawIds.has(modelName)) {
    const variant = catalog.variants.get(modelName);
    if (effortOverride && variant?.familyId && catalog.routes.has(variant.familyId)) {
      const fam = catalog.routes.get(variant.familyId)!;
      const effort = closestEffort(effortOverride, fam.efforts);
      return {
        rawModelId: fam.byEffort.get(effort)!,
        configModelValue: fam.configModelValue,
        effort,
      };
    }
    return {
      rawModelId: modelName,
      configModelValue: variant?.configModelValue ?? modelName,
      effort: variant?.effort,
    };
  }

  // Check if ends with effort suffix like "gemini-3.8-flash-low"
  const effortSuffixMatch = EFFORT_SUFFIX_RE.exec(undated);
  if (effortSuffixMatch) {
    const baseId = undated.slice(0, effortSuffixMatch.index);
    const suffixEffort = effortSuffixMatch[1]!.toLowerCase() as EffortLevel;
    const fam = catalog.routes.get(baseId);
    if (fam) {
      const effort = effortOverride
        ? closestEffort(effortOverride, fam.efforts)
        : closestEffort(suffixEffort, fam.efforts);
      return {
        rawModelId: fam.byEffort.get(effort)!,
        configModelValue: fam.configModelValue,
        effort,
      };
    }
  }

  // Alias matching
  const routeKeys = Array.from(catalog.routes.keys());
  if (/flash/i.test(undated)) {
    const flashFamilyId = routeKeys.find((id) => /flash/i.test(id));
    if (flashFamilyId) {
      return resolveRequestedModel(flashFamilyId, catalog, effortOverride ?? inlineEffort);
    }
  }

  if (/^(?:gemini-.*(?:pro|ultra)|gemini-4)/i.test(undated)) {
    const proFamilyId =
      (catalog.routes.has("gemini-4-argon") ? "gemini-4-argon" : null) ||
      routeKeys.find((id) => /^gemini-/i.test(id) && !/flash/i.test(id));
    if (proFamilyId) {
      return resolveRequestedModel(proFamilyId, catalog, effortOverride ?? inlineEffort);
    }
  }

  if (/claude-.*sonnet/i.test(undated)) {
    const sonnetId = routeKeys.find((id) => /sonnet/i.test(id));
    if (sonnetId) {
      return resolveRequestedModel(sonnetId, catalog, effortOverride ?? inlineEffort);
    }
  }

  if (/claude-.*opus/i.test(undated)) {
    const opusId = routeKeys.find((id) => /opus/i.test(id));
    if (opusId) {
      return resolveRequestedModel(opusId, catalog, effortOverride ?? inlineEffort);
    }
  }

  if (/gpt-oss/i.test(undated)) {
    if (catalog.routes.has("gpt-oss-120b")) {
      return resolveRequestedModel("gpt-oss-120b", catalog, effortOverride ?? inlineEffort);
    }
  }

  return null;
}

/**
 * Returns static fallback catalog for when CLI is not responsive.
 */
export function getStaticFallbackCatalog(): AccountCatalog {
  return buildCatalog(STATIC_FALLBACK_MODELS, { isFallback: true });
}

export const CATALOG_TTL_MS = 5 * 60 * 1000;
export const CATALOG_FAST_WAIT_MS = 1500;
/** Retain a real catalog for a day so a failed probe still answers from it. */
const CATALOG_MAX_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_CACHE_ENTRIES = 128;

interface CatalogLookup {
  catalog: AccountCatalog;
  fellBack: boolean;
}

/**
 * Per-account CatalogService with 5-minute TTL, single-flight refresh,
 * and fast-return static fallback if initial probe exceeds 1500ms.
 */
export class CatalogService {
  private cache = new Map<string, { catalog: AccountCatalog; fetchedAt: number }>();
  private inFlight = new Map<string, Promise<CatalogLookup>>();

  /**
   * Drops long-dead catalogs before each lookup. The TTL is deliberately far
   * longer than `CATALOG_TTL_MS`: a stale-but-real list is what keeps a
   * transiently failing probe from advertising a narrower model set (and thus
   * hiding the account from Magpie's per-account routing).
   */
  private pruneStaleCache(now: number): void {
    for (const [key, entry] of Array.from(this.cache)) {
      if (this.inFlight.has(key)) continue;
      if (now - entry.fetchedAt >= CATALOG_MAX_STALE_AGE_MS) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_CATALOG_CACHE_ENTRIES) {
      let victimKey: string | undefined;
      let victimAge = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (this.inFlight.has(key)) continue;
        if (entry.fetchedAt < victimAge) {
          victimAge = entry.fetchedAt;
          victimKey = key;
        }
      }
      if (victimKey === undefined) return;
      this.cache.delete(victimKey);
    }
  }

  /** Test-only introspection: number of retained per-account catalogs. */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Caches and single-flight slots are scoped by both descriptors: a slot can be
   * re-authenticated against a different isolated account (new `accountRef`,
   * same `slotKey`), and two descriptors must never share one catalog.
   */
  private static cacheScopeKey(account: AccountDescriptor): string {
    return `${account.accountRef}::${account.slotKey}`;
  }

  /**
   * Fetches catalog for an account. `fellBack` says the probe failed and the
   * result is either the previous cached catalog or the static fallback.
   */
  private async fetchAccountCatalog(
    account: AccountDescriptor,
    signal?: AbortSignal
  ): Promise<CatalogLookup> {
    const cacheScopeKey = CatalogService.cacheScopeKey(account);
    const res = await execAgyBounded(account, ["models"], {
      timeoutMs: 10_000,
      signal,
    });

    if (res.exitCode !== 0 || !res.stdout.trim()) {
      const existing = this.cache.get(cacheScopeKey);
      return {
        catalog: existing?.catalog ?? getStaticFallbackCatalog(),
        fellBack: true,
      };
    }

    const rawList = parseAgyModelsOutput(res.stdout);
    if (rawList.length === 0) {
      const existing = this.cache.get(cacheScopeKey);
      return {
        catalog: existing?.catalog ?? getStaticFallbackCatalog(),
        fellBack: true,
      };
    }

    return { catalog: buildCatalog(rawList), fellBack: false };
  }

  /**
   * Returns AccountCatalog plus whether the probe failed and the result came
   * from a previous cache or the static fallback.
   * If fresh cache is available, returns it immediately.
   * Otherwise launches single-flight refresh, waiting up to 1500ms before falling back.
   */
  async getCatalogWithMeta(
    account: AccountDescriptor,
    options?: { forceRefresh?: boolean; signal?: AbortSignal }
  ): Promise<CatalogLookup> {
    const cacheScopeKey = CatalogService.cacheScopeKey(account);
    const now = Date.now();
    this.pruneStaleCache(now);
    const cached = this.cache.get(cacheScopeKey);

    if (!options?.forceRefresh && cached && !cached.catalog.isFallback && now - cached.fetchedAt < CATALOG_TTL_MS) {
      return { catalog: cached.catalog, fellBack: false };
    }

    let refresh = this.inFlight.get(cacheScopeKey);
    if (!refresh) {
      refresh = this.fetchAccountCatalog(account, options?.signal)
        .then((lookup) => {
          if (!lookup.fellBack && !lookup.catalog.isFallback) {
            this.cache.set(cacheScopeKey, { catalog: lookup.catalog, fetchedAt: Date.now() });
          }
          return lookup;
        })
        .catch(() => {
          const prev = this.cache.get(cacheScopeKey);
          return {
            catalog: prev?.catalog ?? getStaticFallbackCatalog(),
            fellBack: true,
          };
        })
        .finally(() => {
          if (this.inFlight.get(cacheScopeKey) === refresh) {
            this.inFlight.delete(cacheScopeKey);
          }
        });

      this.inFlight.set(cacheScopeKey, refresh);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), CATALOG_FAST_WAIT_MS);
    });

    try {
      const winner = await Promise.race([refresh, timeoutPromise]);
      if (winner !== "timed_out") {
        return winner;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Refresh timed out: return cached catalog if available, or static fallback while refreshing in background
    return {
      catalog: cached?.catalog ?? getStaticFallbackCatalog(),
      fellBack: true,
    };
  }

  /**
   * Returns AccountCatalog for the given account.
   */
  async getCatalog(
    account: AccountDescriptor,
    options?: { forceRefresh?: boolean; signal?: AbortSignal }
  ): Promise<AccountCatalog> {
    return (await this.getCatalogWithMeta(account, options)).catalog;
  }

  /**
   * Returns Magpie provider.models() formatted map for an account.
   */
  async getModels(
    account: AccountDescriptor,
    options?: { signal?: AbortSignal; includeRawIds?: boolean }
  ): Promise<Record<string, MagpieModelMetadata>> {
    const { catalog, fellBack } = await this.getCatalogWithMeta(account, {
      signal: options?.signal,
    });
    return buildProviderModels(catalog, {
      includeRawIds: options?.includeRawIds,
      fellBack,
    });
  }

  /**
   * Resolves requested model for an account.
   */
  async resolveModel(
    account: AccountDescriptor,
    requestedModel: string,
    effortOverride?: EffortLevel,
    signal?: AbortSignal
  ): Promise<{ rawModelId: string; configModelValue: string; effort?: EffortLevel } | null> {
    const catalog = await this.getCatalog(account, { signal });
    return resolveRequestedModel(requestedModel, catalog, effortOverride);
  }
}
