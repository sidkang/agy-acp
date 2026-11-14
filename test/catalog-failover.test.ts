import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/index";
import type { AccountDescriptor } from "../src/types";
import { getAgyBinaryFingerprint } from "../src/accounts/env";
import { withEnv } from "./fixtures/helpers";
import {
  CatalogService,
  STATIC_FALLBACK_MODELS,
  buildProviderModels,
  getStaticFallbackCatalog,
  resolveRequestedModel,
} from "../src/usage/catalog";

const TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "agy-catalog-failover-test-"),
);
let origEnv: Record<string, string | undefined> = {};

const UUID_A = "aaaa1111-1111-4111-8111-111111111111";
const UUID_B = "bbbb2222-2222-4222-8222-222222222222";
const UUID_FAIL = "cccc3333-3333-4333-8333-333333333333";

const FELL_BACK_SYM = Symbol.for("magpie.fellBack");

function writeMockAgyScript(): string {
  const scriptPath = path.join(TEMP_ROOT, "mock-agy");
  const script = `#!/usr/bin/env bun
const home = process.env.HOME || "";
const args = process.argv.slice(2);
if (args[0] === "models") {
  if (home.includes("${UUID_A}")) {
    console.log("Fetching available models...");
    console.log("gemini-4-carbon-low\\tGemini 4 Carbon (Low)");
    console.log("gemini-4-carbon-medium\\tGemini 4 Carbon (Medium)");
    console.log("gemini-4-carbon-high\\tGemini 4 Carbon (High)");
    console.log("gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)");
    console.log("gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)");
    console.log("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)");
    process.exit(0);
  }
  if (home.includes("${UUID_B}")) {
    console.log("Fetching available models...");
    console.log("gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)");
    console.log("gemini-4-hydrogen-medium\\tGemini 4 Hydrogen (Medium)");
    console.log("gemini-4-hydrogen-high\\tGemini 4 Hydrogen (High)");
    console.log("gemini-4-hydrogen-xhigh\\tGemini 4 Hydrogen (XHigh)");
    console.log("claude-opus-5-5-low\\tClaude Opus 5.5 (Low)");
    console.log("claude-opus-5-5-medium\\tClaude Opus 5.5 (Medium)");
    console.log("claude-opus-5-5-high\\tClaude Opus 5.5 (High)");
    process.exit(0);
  }
  process.exit(1);
}
process.exit(0);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

beforeAll(() => {
  origEnv = {
    ANTIGRAVITY_MAGPIE_DATA_DIR: process.env.ANTIGRAVITY_MAGPIE_DATA_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    AGY_PATH: process.env.AGY_PATH,
  };
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = path.join(TEMP_ROOT, "data");
  process.env.XDG_CONFIG_HOME = path.join(TEMP_ROOT, "config");
  process.env.XDG_CACHE_HOME = path.join(TEMP_ROOT, "cache");
  fs.mkdirSync(path.join(TEMP_ROOT, "data"), { recursive: true });
  fs.mkdirSync(path.join(TEMP_ROOT, "config"), { recursive: true });
  fs.mkdirSync(path.join(TEMP_ROOT, "cache"), { recursive: true });
  process.env.AGY_PATH = writeMockAgyScript();
});

afterAll(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("Fallback catalog & agy 1.5.8 parity", () => {
  test("STATIC_FALLBACK_MODELS covers all 22 real agy 1.5.8 variants and families", () => {
    const expectedRawIds = [
      "gemini-4-carbon-high",
      "gemini-4-carbon-medium",
      "gemini-4-carbon-low",
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
      "gemini-4-argon-low",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-opus-5-5-high",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-medium",
      "claude-sonnet-5-5-low",
      "gpt-oss-120b-medium",
    ];

    expect(STATIC_FALLBACK_MODELS).toHaveLength(22);
    const catalog = getStaticFallbackCatalog();
    expect(catalog.isFallback).toBe(true);
    for (const rawId of expectedRawIds) {
      expect(catalog.rawIds.has(rawId)).toBe(true);
    }

    const byId = new Map(catalog.models.map((m) => [m.id, m]));
    expect(byId.get("gemini-4-carbon")?.variants).toEqual(["low", "medium", "high"]);
    expect(byId.get("gemini-4-hydrogen")?.variants).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(byId.get("gemini-4-argon")?.variants).toEqual(["low", "medium", "high"]);
    expect(byId.get("gemini-3.8-flash")?.variants).toEqual(["low", "medium", "high"]);
    expect(byId.get("claude-opus-5-5")?.variants).toEqual(["low", "medium", "high"]);
    expect(byId.get("claude-sonnet-5-5")?.variants).toEqual(["low", "medium", "high"]);
    expect(byId.get("gpt-oss-120b")?.variants).toEqual(["medium"]);
    expect(byId.has("gemini-pro-orchestrator")).toBe(true);
    expect(byId.has("gemini-pro-orchestrator-argon")).toBe(true);
  });

  test("resolveRequestedModel keeps carbon on carbon (never aliases argon) and resolves hydrogen xhigh", () => {
    const catalog = getStaticFallbackCatalog();

    expect(resolveRequestedModel("gemini-4-carbon", catalog)).toEqual({
      rawModelId: "gemini-4-carbon-medium",
      configModelValue: "gemini-4-carbon",
      effort: "medium",
    });
    expect(resolveRequestedModel("gemini-4-carbon", catalog, "high")).toEqual({
      rawModelId: "gemini-4-carbon-high",
      configModelValue: "gemini-4-carbon",
      effort: "high",
    });
    expect(resolveRequestedModel("gemini-4-carbon:low", catalog)).toEqual({
      rawModelId: "gemini-4-carbon-low",
      configModelValue: "gemini-4-carbon",
      effort: "low",
    });

    expect(resolveRequestedModel("gemini-4-hydrogen", catalog, "xhigh")).toEqual({
      rawModelId: "gemini-4-hydrogen-xhigh",
      configModelValue: "gemini-4-hydrogen",
      effort: "xhigh",
    });
    expect(resolveRequestedModel("gemini-4-hydrogen:xhigh", catalog)).toEqual({
      rawModelId: "gemini-4-hydrogen-xhigh",
      configModelValue: "gemini-4-hydrogen",
      effort: "xhigh",
    });
    expect(resolveRequestedModel("gemini-4-hydrogen-xhigh", catalog)).toEqual({
      rawModelId: "gemini-4-hydrogen-xhigh",
      configModelValue: "gemini-4-hydrogen",
      effort: "xhigh",
    });

    expect(resolveRequestedModel("gemini-pro-orchestrator", catalog)).toEqual({
      rawModelId: "gemini-pro-orchestrator",
      configModelValue: "gemini-pro-orchestrator",
      effort: undefined,
    });
    expect(
      resolveRequestedModel("gemini-pro-orchestrator-argon", catalog),
    ).toEqual({
      rawModelId: "gemini-pro-orchestrator-argon",
      configModelValue: "gemini-pro-orchestrator-argon",
      effort: undefined,
    });
  });

  test("marks fallback provider models with non-enumerable magpie.fellBack symbol while live catalog leaves it unset", async () => {
    const fallbackModels = buildProviderModels(getStaticFallbackCatalog(), {
      includeRawIds: false,
    });
    expect(Reflect.get(fallbackModels, FELL_BACK_SYM)).toBe(true);
    expect(Object.keys(fallbackModels)).toContain("gemini-4-carbon");
    expect(Object.keys(fallbackModels)).toContain("gemini-4-hydrogen");

    const svc = new CatalogService();
    const failAccount: AccountDescriptor = {
      slotKey: "agy-acp#fail",
      accountRef: UUID_FAIL,
      mode: "isolated",
      label: "fail@example.com",
      isolatedHomeDir: path.join(TEMP_ROOT, "data", "accounts", UUID_FAIL),
    };
    fs.mkdirSync(path.join(failAccount.isolatedHomeDir!, ".gemini", "antigravity-cli"), {
      recursive: true,
    });

    const failedModels = await svc.getModels(failAccount);
    expect(Reflect.get(failedModels, FELL_BACK_SYM)).toBe(true);

    const liveAccountA: AccountDescriptor = {
      slotKey: "agy-acp",
      accountRef: UUID_A,
      mode: "isolated",
      label: "a@example.com",
      isolatedHomeDir: path.join(TEMP_ROOT, "data", "accounts", UUID_A),
    };
    fs.mkdirSync(path.join(liveAccountA.isolatedHomeDir!, ".gemini", "antigravity-cli"), {
      recursive: true,
    });

    const liveModelsA = await svc.getModels(liveAccountA);
    expect(Reflect.get(liveModelsA, FELL_BACK_SYM)).toBeUndefined();
  });
});

describe("Per-account catalog & loader isolation", () => {
  test("authoritative per-account catalog keeps absent models absent and isolates two account loaders", async () => {
    const svc = new CatalogService();
    const accA: AccountDescriptor = {
      slotKey: "agy-acp",
      accountRef: UUID_A,
      mode: "isolated",
      label: "a@example.com",
      isolatedHomeDir: path.join(TEMP_ROOT, "data", "accounts", UUID_A),
    };
    const accB: AccountDescriptor = {
      slotKey: "agy-acp#second",
      accountRef: UUID_B,
      mode: "isolated",
      label: "b@example.com",
      isolatedHomeDir: path.join(TEMP_ROOT, "data", "accounts", UUID_B),
    };
    for (const acc of [accA, accB]) {
      fs.mkdirSync(path.join(acc.isolatedHomeDir!, ".gemini", "antigravity-cli"), {
        recursive: true,
      });
    }

    const modelsA = await svc.getModels(accA);
    const modelsB = await svc.getModels(accB);

    // Account A has carbon & flash only; Account B has hydrogen & claude-opus-5-5 only.
    // Neither account's authoritative fresh catalog is unioned with the other's.
    expect(Object.keys(modelsA).sort()).toEqual([
      "gemini-3.8-flash",
      "gemini-4-carbon",
    ]);
    expect(Object.keys(modelsB).sort()).toEqual([
      "claude-opus-5-5",
      "gemini-4-hydrogen",
    ]);
    expect(Reflect.get(modelsA, FELL_BACK_SYM)).toBeUndefined();
    expect(Reflect.get(modelsB, FELL_BACK_SYM)).toBeUndefined();

    expect(await svc.resolveModel(accA, "claude-opus-5-5")).toBeNull();
    expect(await svc.resolveModel(accB, "gemini-3.8-flash")).toBeNull();
    expect(await svc.resolveModel(accA, "gemini-4-carbon", "high")).toEqual({
      rawModelId: "gemini-4-carbon-high",
      configModelValue: "gemini-4-carbon",
      effort: "high",
    });
    expect(await svc.resolveModel(accB, "gemini-4-hydrogen", "xhigh")).toEqual({
      rawModelId: "gemini-4-hydrogen-xhigh",
      configModelValue: "gemini-4-hydrogen",
      effort: "xhigh",
    });

    // Exercise two per-account loaders through the plugin entry
    let activeSlot = "agy-acp";
    const instance = await plugin.server({
      magpie: {
        account: () => activeSlot,
      },
    });

    const authA = {
      type: "api",
      key: `agy-isolated:${UUID_A}`,
      accountId: "a@example.com",
      metadata: { schemaVersion: 1, accountRef: UUID_A, mode: "isolated", email: "a@example.com" },
    };
    const authB = {
      type: "api",
      key: `agy-isolated:${UUID_B}`,
      accountId: "b@example.com",
      metadata: { schemaVersion: 1, accountRef: UUID_B, mode: "isolated", email: "b@example.com" },
    };

    activeSlot = "agy-acp";
    const loaderA = await instance.auth.loader(async () => authA);
    const providerModelsA = await instance.provider.models(undefined, { auth: authA });

    activeSlot = "agy-acp#second";
    const loaderB = await instance.auth.loader(async () => authB);
    const providerModelsB = await instance.provider.models(undefined, { auth: authB });

    expect(Object.keys(providerModelsA).sort()).toEqual([
      "gemini-3.8-flash",
      "gemini-4-carbon",
    ]);
    expect(Object.keys(providerModelsB).sort()).toEqual([
      "claude-opus-5-5",
      "gemini-4-hydrogen",
    ]);

    // Asking Account A's loader for a model only Account B has must fail 400 (not borrow B's catalog)
    const resAForClaude = await loaderA.fetch("agy://local/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resAForClaude.status).toBe(400);
    const bodyA: any = await resAForClaude.json();
    expect(bodyA?.error?.message).toContain("Unknown or unavailable Antigravity model");

    // Asking Account B's loader for a model only Account A has must fail 400
    const resBForFlash = await loaderB.fetch("agy://local/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resBForFlash.status).toBe(400);
    const bodyB: any = await resBForFlash.json();
    expect(bodyB?.error?.message).toContain("Unknown or unavailable Antigravity model");
  });
});

async function catalogCheckpoint(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Catalog checkpoint timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function catalogAccount(name: string): AccountDescriptor {
  const home = path.join(TEMP_ROOT, name);
  fs.mkdirSync(home, { recursive: true });
  return { accountRef: crypto.randomUUID(), slotKey: name, mode: "isolated", label: name, isolatedHomeDir: home };
}

function catalogProbe(bin: string, log: string, model: string, delay: number, fail = false): void {
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, "start ${model}\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(log)}, "end ${model}\\n");
  ${fail ? "process.exit(1);" : `console.log(${JSON.stringify(`${model}\t${model}`)});`}
}, ${delay});
`, { mode: 0o755 });
}

describe("Catalog refresh cancellation and binary fencing", () => {
  test("caller abort is local, pre-aborted calls do not probe, and abandoned callers leave a bounded refresh running", async () => {
    const bin = path.join(TEMP_ROOT, "abort-catalog-probe");
    const log = path.join(TEMP_ROOT, "abort-catalog.log");
    catalogProbe(bin, log, "gemini-live-medium", 180);
    await withEnv({ AGY_PATH: bin }, async () => {
      const svc = new CatalogService(), account = catalogAccount("abort-catalog");
      const a = new AbortController();
      const first = svc.getCatalogWithMeta(account, { signal: a.signal });
      const second = svc.getCatalogWithMeta(account);
      await catalogCheckpoint(() => fs.existsSync(log));
      a.abort();
      expect((await first).fellBack).toBe(true);
      const live = await second;
      expect(live.fellBack).toBe(false);
      expect(live.catalog.rawIds.has("gemini-live-medium")).toBe(true);
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(1);
      const pre = new AbortController(); pre.abort();
      const preFresh = await svc.getCatalogWithMeta(account, { signal: pre.signal });
      expect(preFresh.fellBack).toBe(true);
      expect(preFresh.catalog).toBe(live.catalog);
      await svc.getCatalogWithMeta(catalogAccount("pre-aborted-catalog"), { signal: pre.signal });
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(1);

      const backgroundAccount = catalogAccount("background-catalog");
      const b = new AbortController(), c = new AbortController();
      const third = svc.getCatalogWithMeta(backgroundAccount, { signal: b.signal });
      const fourth = svc.getCatalogWithMeta(backgroundAccount, { signal: c.signal });
      await catalogCheckpoint(() => fs.readFileSync(log, "utf8").match(/start/g)?.length === 2);
      b.abort(); c.abort();
      expect((await third).fellBack).toBe(true);
      expect((await fourth).fellBack).toBe(true);
      // Catalog probes are intentionally not owned by callers: no one caller,
      // or collection of short-lived callers, can cancel the bounded refresh.
      const completed = await svc.getCatalogWithMeta(backgroundAccount);
      expect(completed.fellBack).toBe(false);
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(2);
    });
  });

  test("in-place binary size/mtime changes refresh immediately and failed upgrades retain real catalogs without refreshing their fingerprint", async () => {
    const bin = path.join(TEMP_ROOT, "upgrade-catalog-probe");
    const log = path.join(TEMP_ROOT, "upgrade-catalog.log");
    catalogProbe(bin, log, "gemini-original-medium", 0);
    await withEnv({ AGY_PATH: bin }, async () => {
      const svc = new CatalogService(), account = catalogAccount("upgrade-catalog");
      const original = await svc.getCatalogWithMeta(account);
      expect(original.fellBack).toBe(false);
      const fingerprint = getAgyBinaryFingerprint();
      catalogProbe(bin, log, "gemini-upgraded-long-name-medium", 0);
      expect(getAgyBinaryFingerprint()).not.toBe(fingerprint);
      const upgraded = await svc.getCatalogWithMeta(account);
      expect(upgraded.fellBack).toBe(false);
      expect(upgraded.catalog.rawIds.has("gemini-upgraded-long-name-medium")).toBe(true);
      const beforeMtime = getAgyBinaryFingerprint();
      const newMtime = new Date(Date.now() + 10_000);
      fs.utimesSync(bin, newMtime, newMtime);
      expect(getAgyBinaryFingerprint()).not.toBe(beforeMtime);
      const mtimeRefreshed = await svc.getCatalogWithMeta(account);
      expect(mtimeRefreshed.fellBack).toBe(false);
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(3);

      catalogProbe(bin, log, "failed-upgrade", 0, true);
      for (let i = 0; i < 2; i++) {
        const failed = await svc.getCatalogWithMeta(account);
        expect(failed.fellBack).toBe(true);
        expect(failed.catalog).toBe(mtimeRefreshed.catalog);
        expect(failed.catalog.rawIds.has("gemini-upgraded-long-name-medium")).toBe(true);
      }
      // A failed probe must not mark the old catalog fresh for the new binary.
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(5);
    });
    await withEnv({ AGY_PATH: path.join(TEMP_ROOT, "missing-binary") }, () => {
      expect(getAgyBinaryFingerprint()).toBe("missing");
    });
  });

  test("an old-binary refresh neither publishes nor clears a newer in-flight generation", async () => {
    const bin = path.join(TEMP_ROOT, "generation-catalog-probe");
    const log = path.join(TEMP_ROOT, "generation-catalog.log");
    catalogProbe(bin, log, "gemini-old-medium", 100);
    await withEnv({ AGY_PATH: bin }, async () => {
      const svc = new CatalogService(), account = catalogAccount("generation-catalog");
      const old = svc.getCatalogWithMeta(account);
      await catalogCheckpoint(() => fs.existsSync(log));
      catalogProbe(bin, log, "gemini-new-long-medium", 300);
      const fresh = svc.getCatalogWithMeta(account);
      expect((await old).catalog.rawIds.has("gemini-old-medium")).toBe(true);
      const joined = svc.getCatalogWithMeta(account);
      const [newResult, joinedResult] = await Promise.all([fresh, joined]);
      expect(newResult.catalog.rawIds.has("gemini-new-long-medium")).toBe(true);
      expect(joinedResult.catalog).toBe(newResult.catalog);
      expect((await svc.getCatalogWithMeta(account)).catalog).toBe(newResult.catalog);
      expect(fs.readFileSync(log, "utf8").match(/start/g)).toHaveLength(2);
    });
  });
});
