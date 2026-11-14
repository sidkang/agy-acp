import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AccountDescriptor } from "../src/types";
import {
  execAgyBounded,
  buildAgyEnvAndArgs,
  getBrowserShimDir,
  getPluginDataRoot,
  readStoredAgyOAuthCredentials,
  redactSecrets,
  resolveIsolatedHomeDir,
  sweepStaleAccountStorage,
} from "../src/accounts/env";
import {
  accountRefFromEmail,
  createAuthMethods,
  detectLoggedInEmail,
  extractAuthorizationCode,
  importAccountFiles,
  parseImportedAccounts,
  resolveAccountDescriptor,
} from "../src/accounts/auth";
import { buildProviderOptionSchemas, readProviderOptions } from "../src/options";
import {
  buildCatalog,
  buildProviderModels,
  closestEffort,
  getModelLimits,
  getStaticFallbackCatalog,
  parseAgyModelsOutput,
  resolveRequestedModel,
  CatalogService,
} from "../src/usage/catalog";
import {
  cadence,
  formatCodeAssistPlan,
  parseResetTime,
  parseUsageReport,
  queryAccountUsage,
  queryAccountPlan,
} from "../src/usage/quota";
import { readConversationStepUsages } from "../src/usage/step-usage";
import { withEnv } from "./fixtures/helpers";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-accounts-usage-test-"));
const ORIGINAL_DATA_DIR = process.env.ANTIGRAVITY_MAGPIE_DATA_DIR;
const ORIGINAL_AGY_ACP_DATA_DIR = process.env.AGY_ACP_DATA_DIR;
const ORIGINAL_AGY_PATH = process.env.AGY_PATH;

const VALID_UUID = "e2b65597-96a9-46be-8f3e-52ebc689b7b9";
const OTHER_UUID = "0f6d9d0a-0c4f-4f52-9a3f-2f0b4c1d2e3a";

/**
 * `buildAgyEnvAndArgs` resolves the real `agy` binary before doing anything
 * else, so it throws on a machine where it is not installed (CI). These tests
 * point `AGY_PATH` at a throwaway no-op executable inside TEST_DIR instead.
 */
const MOCK_AGY_BIN = path.join(
  TEST_DIR,
  process.platform === "win32" ? "mock-agy.cmd" : "mock-agy"
);

function ensureMockAgyBin(): string {
  const content = process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  // `mode` is applied by the open(2) call itself, so no follow-up chmod is needed.
  fs.writeFileSync(MOCK_AGY_BIN, content, { mode: 0o755 });
  return MOCK_AGY_BIN;
}

const REAL_AGY_MODELS_OUTPUT = `Fetching available models...
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

const REAL_USAGE_JSON = {
  conversation_id: "",
  status: "SUCCESS",
  response:
    "Gemini Models\tWeekly Limit Remaining\t51%\t2026-11-14T07:57:52Z\nGemini Models\tFive Hour Limit Remaining\t77%\t2026-11-13T04:25:05Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-18T15:07:06Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-13T07:23:50Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.5085457563400269,
              reset_time: "2026-11-14T07:57:52Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.7706645727157593,
              reset_time: "2026-11-13T04:25:05Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1.0,
              reset_time: "2026-11-18T15:07:06Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1.0,
              reset_time: "2026-11-13T07:23:50Z",
            },
          ],
        },
      ],
    },
  },
};

beforeAll(() => {
  // `getPluginDataRoot()` prefers AGY_ACP_DATA_DIR over ANTIGRAVITY_MAGPIE_DATA_DIR,
  // so pin both at this file's sandbox root instead of inheriting the runner's.
  process.env.AGY_ACP_DATA_DIR = TEST_DIR;
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  if (ORIGINAL_AGY_ACP_DATA_DIR !== undefined) {
    process.env.AGY_ACP_DATA_DIR = ORIGINAL_AGY_ACP_DATA_DIR;
  } else {
    delete process.env.AGY_ACP_DATA_DIR;
  }
  if (ORIGINAL_DATA_DIR !== undefined) {
    process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = ORIGINAL_DATA_DIR;
  } else {
    delete process.env.ANTIGRAVITY_MAGPIE_DATA_DIR;
  }
  if (ORIGINAL_AGY_PATH !== undefined) {
    process.env.AGY_PATH = ORIGINAL_AGY_PATH;
  } else {
    delete process.env.AGY_PATH;
  }
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("src/accounts/env.ts", () => {
  test("getPluginDataRoot returns and creates directory with mode 0o700", () => {
    const root = getPluginDataRoot();
    expect(root).toBe(TEST_DIR);
    expect(fs.existsSync(root)).toBe(true);
    const stat = fs.statSync(root);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((stat.mode & 0o777) === 0o700).toBe(true);
    }
  });

  test("resolveIsolatedHomeDir strictly validates UUID v4 and creates isolated directory structure", () => {
    // Rejects path traversal and non-UUIDs
    expect(() => resolveIsolatedHomeDir("../foo")).toThrow("must be a valid UUID");
    expect(() => resolveIsolatedHomeDir("abc")).toThrow("must be a valid UUID");
    expect(() => resolveIsolatedHomeDir("12345")).toThrow("must be a valid UUID");
    expect(() => resolveIsolatedHomeDir("../../etc/passwd")).toThrow("must be a valid UUID");

    // Accepts valid UUID
    const homeDir = resolveIsolatedHomeDir(VALID_UUID);
    expect(homeDir).toBe(path.join(TEST_DIR, "accounts", VALID_UUID.toLowerCase()));
    expect(fs.existsSync(homeDir)).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".gemini"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".gemini", "antigravity-cli"))).toBe(true);

    if (process.platform !== "win32") {
      const mode = fs.statSync(homeDir).mode & 0o777;
      expect(mode).toBe(0o700);
      const geminiMode = fs.statSync(path.join(homeDir, ".gemini")).mode & 0o700;
      expect(geminiMode).toBe(0o700);
    }
  });

  test("browser suppression shim directory contains executable open/xdg-open that exit 1", () => {
    const shimDir = getBrowserShimDir();
    expect(fs.existsSync(shimDir)).toBe(true);

    if (process.platform !== "win32") {
      const openPath = path.join(shimDir, "open");
      const xdgOpenPath = path.join(shimDir, "xdg-open");
      expect(fs.existsSync(openPath)).toBe(true);
      expect(fs.existsSync(xdgOpenPath)).toBe(true);

      // Verify that executing the shim exits with code 1
      const resOpen = spawnSync(openPath, ["https://google.com"]);
      expect(resOpen.status).toBe(1);

      const resXdg = spawnSync(xdgOpenPath, ["https://google.com"]);
      expect(resXdg.status).toBe(1);
    } else {
      const openCmd = path.join(shimDir, "open.cmd");
      expect(fs.existsSync(openCmd)).toBe(true);
    }
  });

  test("buildAgyEnvAndArgs sets up isolated environment correctly", async () => {
    const isolatedAccount: AccountDescriptor = {
      slotKey: `agy-isolated:${VALID_UUID}`,
      accountRef: VALID_UUID,
      mode: "isolated",
      label: "test-isolated",
      isolatedHomeDir: resolveIsolatedHomeDir(VALID_UUID),
    };

    // `agy` resolution points at a throwaway executable (CI has no `agy` install),
    // and every cross-contaminating var is polluted to prove it gets purged.
    await withEnv(
      {
        AGY_PATH: ensureMockAgyBin(),
        GEMINI_API_KEY: "polluted-gemini",
        GOOGLE_API_KEY: "polluted-google",
        GOOGLE_APPLICATION_CREDENTIALS: "polluted-creds",
        ANTIGRAVITY_APP_DATA_DIR: "polluted-app-data",
        ANTIGRAVITY_CONFIG_REL_DIR: "polluted-config-rel",
      },
      () => {
        const acpResult = buildAgyEnvAndArgs(isolatedAccount, ["acp", "--login"]);
        const shimDir = getBrowserShimDir();

        // Verify sanitization
        expect(acpResult.env.GEMINI_API_KEY).toBeUndefined();
        expect(acpResult.env.GOOGLE_API_KEY).toBeUndefined();
        expect(acpResult.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
        expect(acpResult.env.ANTIGRAVITY_APP_DATA_DIR).toBeUndefined();
        expect(acpResult.env.ANTIGRAVITY_CONFIG_REL_DIR).toBeUndefined();

        // Verify browser suppression
        expect(acpResult.env.BROWSER).toBe("/usr/bin/false");
        expect(acpResult.env.PATH?.startsWith(shimDir)).toBe(true);
        expect(acpResult.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");

        // Verify isolated tokens & directories
        expect(acpResult.env.HOME).toBe(isolatedAccount.isolatedHomeDir!);
        expect(acpResult.env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 22");
        expect(acpResult.env.XDG_CONFIG_HOME).toBe(
          path.join(isolatedAccount.isolatedHomeDir!, ".config")
        );

        // Verify args for `acp` have absolute --gemini-dir and relative --app-data-dir
        expect(acpResult.finalArgs[0]).toBe("acp");
        const geminiIdx = acpResult.finalArgs.indexOf("--gemini-dir");
        expect(geminiIdx).toBeGreaterThan(0);
        expect(acpResult.finalArgs[geminiIdx + 1]).toBe(
          path.join(isolatedAccount.isolatedHomeDir!, ".gemini")
        );
        const appDataIdx = acpResult.finalArgs.indexOf("--app-data-dir");
        expect(appDataIdx).toBeGreaterThan(0);
        expect(acpResult.finalArgs[appDataIdx + 1]).toBe("antigravity-cli");
        expect(path.isAbsolute(acpResult.finalArgs[appDataIdx + 1]!)).toBe(false);

        // Verify args for `models` do NOT append --gemini-dir
        const modelsResult = buildAgyEnvAndArgs(isolatedAccount, ["models"]);
        expect(modelsResult.finalArgs).toEqual(["models"]);
      }
    );
  });

  test("buildAgyEnvAndArgs keeps loopback out of proxies and applies Magpie proxy fallbacks", async () => {
    const isolatedAccount: AccountDescriptor = {
      slotKey: `agy-isolated:${OTHER_UUID}`,
      accountRef: OTHER_UUID,
      mode: "isolated",
      label: "proxy-test",
      isolatedHomeDir: resolveIsolatedHomeDir(OTHER_UUID),
    };

    await withEnv(
      {
        // Point `agy` resolution at a throwaway executable: CI has no `agy` install.
        AGY_PATH: ensureMockAgyBin(),
        NO_PROXY: "example.com,localhost",
        no_proxy: undefined,
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        ALL_PROXY: undefined,
        all_proxy: undefined,
        MAGPIE_HTTPS_PROXY: "http://proxy.example:8443",
        MAGPIE_HTTP_PROXY: "http://proxy.example:8080",
        MAGPIE_ALL_PROXY: "socks5://proxy.example:1080",
      },
      () => {
        const result = buildAgyEnvAndArgs(isolatedAccount, ["models"]);

        expect(result.env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1");
        expect(result.env.no_proxy).toBe("127.0.0.1,localhost,::1");
        expect(result.env.HTTPS_PROXY).toBe("http://proxy.example:8443");
        expect(result.env.HTTP_PROXY).toBe("http://proxy.example:8080");
        expect(result.env.ALL_PROXY).toBe("socks5://proxy.example:1080");
        expect(result.env.USERPROFILE).toBe(isolatedAccount.isolatedHomeDir!);
      }
    );
  });

  test("buildAgyEnvAndArgs preserves host settings for host accounts", async () => {
    const hostAccount: AccountDescriptor = {
      slotKey: "agy",
      accountRef: "host",
      mode: "host",
      label: "local-agy (host)",
      isolatedHomeDir: null,
    };

    // Point `agy` resolution at a throwaway executable: CI has no `agy` install.
    await withEnv({ AGY_PATH: ensureMockAgyBin() }, () => {
      const result = buildAgyEnvAndArgs(hostAccount, ["models"]);
      expect(result.env.SSH_CONNECTION).toBe(process.env.SSH_CONNECTION);
      expect(result.finalArgs).toEqual(["models"]);
      expect(result.env.BROWSER).toBe("/usr/bin/false");
    });
  });

  test("redactSecrets sanitizes OAuth codes, tokens, Bearer auth, and loopback mcp tokens", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("https://antigravity.google/oauth-callback?code=4/0AeanSecretCode123&scope=all"))
      .toBe("https://antigravity.google/oauth-callback?code=[REDACTED]&scope=all");
    expect(redactSecrets("code=secret-code-xyz access_token=secret-token-123 refresh_token=secret-refresh-456"))
      .toBe("code=[REDACTED] access_token=[REDACTED] refresh_token=[REDACTED]");
    expect(redactSecrets('{"access_token": "ya29.secretToken", "refresh_token": "1//04secret"}'))
      .toBe('{"access_token": "[REDACTED]", "refresh_token": "[REDACTED]"}');
    expect(redactSecrets("Authorization: Bearer ya29.a0AfH6SM..."))
      .toBe("Authorization: Bearer [REDACTED]");
    expect(redactSecrets("Connecting to http://127.0.0.1:49152/mcp/sec-tok-998877665544"))
      .toBe("Connecting to http://127.0.0.1:49152/mcp/[REDACTED]");
    expect(redactSecrets("Google auth code: 4/0AeanS-abcdef12345678901234567890"))
      .toBe("Google auth code: [REDACTED]");
    expect(redactSecrets("Bare refresh 1//04secretRefreshTokenValue and ya29.a0secretAccessToken"))
      .toBe("Bare refresh [REDACTED] and [REDACTED]");
  });

  test("readStoredAgyOAuthCredentials reads plain and base64 JSON with object or stringified token", () => {
    const expiryIso = "2026-12-01T00:00:00.000Z";
    const expectedMs = Date.parse(expiryIso);
    const tokenObj = {
      access_token: "ya29.test-access",
      refresh_token: "1//04test-refresh",
      expiry: expiryIso,
    };

    const cases: Array<{ name: string; content: string }> = [
      {
        name: "plain-obj",
        content: JSON.stringify({ token: tokenObj }),
      },
      {
        name: "plain-str",
        content: JSON.stringify({ token: JSON.stringify(tokenObj) }),
      },
      {
        name: "b64-obj",
        content: Buffer.from(JSON.stringify({ token: tokenObj }), "utf8").toString("base64"),
      },
      {
        name: "b64-str",
        content: Buffer.from(JSON.stringify({ token: JSON.stringify(tokenObj) }), "utf8").toString("base64"),
      },
    ];

    for (const c of cases) {
      const isoHome = fs.mkdtempSync(path.join(TEST_DIR, `oauth-${c.name}-`));
      const cliDir = path.join(isoHome, ".gemini", "antigravity-cli");
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, "antigravity-oauth-token"), c.content, "utf8");

      const account: AccountDescriptor = {
        slotKey: `slot-${c.name}`,
        accountRef: VALID_UUID,
        mode: "isolated",
        label: c.name,
        isolatedHomeDir: isoHome,
      };

      expect(readStoredAgyOAuthCredentials(account)).toEqual({
        accessToken: "ya29.test-access",
        refreshToken: "1//04test-refresh",
        expiresAtMs: expectedMs,
      });
    }
  });

  test("sweepStaleAccountStorage prunes stale unprotected artifacts and preserves protected and fresh ones", async () => {
    const tempDataDir = fs.mkdtempSync(path.join(TEST_DIR, "sweep-data-"));
    const cliDir = path.join(
      tempDataDir,
      "accounts",
      VALID_UUID,
      ".gemini",
      "antigravity-cli",
    );
    const convDir = path.join(cliDir, "conversations");
    const brainDir = path.join(cliDir, "brain");
    const logDir = path.join(cliDir, "log");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const nowMs = Date.now();
    const oldTime = new Date(nowMs - 49 * 60 * 60 * 1000);
    const freshTime = new Date(nowMs - 30 * 60 * 1000);

    // Old unprotected artifacts -> should be removed
    const oldDb = path.join(convDir, "old-sess.db");
    const oldWal = path.join(convDir, "old-sess.db-wal");
    const oldBrainDir = path.join(brainDir, "old-sess");
    const oldBrainFile = path.join(oldBrainDir, "out.txt");
    const oldLog = path.join(logDir, "cli-old.log");
    fs.writeFileSync(oldDb, "db");
    fs.writeFileSync(oldWal, "wal");
    fs.mkdirSync(oldBrainDir, { recursive: true });
    fs.writeFileSync(oldBrainFile, "old output");
    fs.writeFileSync(oldLog, "old log");
    fs.utimesSync(oldDb, oldTime, oldTime);
    fs.utimesSync(oldWal, oldTime, oldTime);
    fs.utimesSync(oldBrainFile, oldTime, oldTime);
    fs.utimesSync(oldBrainDir, oldTime, oldTime);
    fs.utimesSync(oldLog, oldTime, oldTime);

    // Old protected artifacts -> should be preserved
    const keepDb = path.join(convDir, "keep-sess.db");
    const keepBrainDir = path.join(brainDir, "keep-sess");
    const keepBrainFile = path.join(keepBrainDir, "out.txt");
    fs.writeFileSync(keepDb, "db");
    fs.mkdirSync(keepBrainDir, { recursive: true });
    fs.writeFileSync(keepBrainFile, "keep output");
    fs.utimesSync(keepDb, oldTime, oldTime);
    fs.utimesSync(keepBrainFile, oldTime, oldTime);
    fs.utimesSync(keepBrainDir, oldTime, oldTime);

    // Fresh artifacts -> should be preserved (including old brain dir with fresh nested file)
    const freshDb = path.join(convDir, "fresh-sess.db");
    const freshLog = path.join(logDir, "cli-fresh.log");
    const nestedBrainDir = path.join(brainDir, "resumed-sess");
    const nestedSubDir = path.join(nestedBrainDir, ".system_generated", "logs");
    const nestedFreshFile = path.join(nestedSubDir, "transcript.jsonl");
    fs.writeFileSync(freshDb, "db");
    fs.writeFileSync(freshLog, "fresh log");
    fs.mkdirSync(nestedSubDir, { recursive: true });
    fs.writeFileSync(nestedFreshFile, "fresh step");
    fs.utimesSync(freshDb, freshTime, freshTime);
    fs.utimesSync(freshLog, freshTime, freshTime);
    fs.utimesSync(nestedFreshFile, freshTime, freshTime);
    fs.utimesSync(nestedSubDir, oldTime, oldTime);
    fs.utimesSync(path.join(nestedBrainDir, ".system_generated"), oldTime, oldTime);
    fs.utimesSync(nestedBrainDir, oldTime, oldTime);

    await withEnv({ AGY_ACP_DATA_DIR: tempDataDir }, () => {
      const removed = sweepStaleAccountStorage({
        now: nowMs,
        protectedSessionIds: new Set(["keep-sess"]),
      });
      expect(removed).toBe(3);

      expect(fs.existsSync(oldDb)).toBe(false);
      expect(fs.existsSync(oldWal)).toBe(false);
      expect(fs.existsSync(oldBrainDir)).toBe(false);
      expect(fs.existsSync(oldLog)).toBe(false);

      expect(fs.existsSync(keepDb)).toBe(true);
      expect(fs.existsSync(keepBrainFile)).toBe(true);
      expect(fs.existsSync(freshDb)).toBe(true);
      expect(fs.existsSync(freshLog)).toBe(true);
      expect(fs.existsSync(nestedFreshFile)).toBe(true);
    });
  });
});

describe("detectLoggedInEmail", () => {
  test("reads an address with dots on both sides of the @", () => {
    // The old pattern excluded dots, so a dotted local part never matched and the
    // account was labelled and indexed wrongly.
    expect(detectLoggedInEmail("Logged in as alice@example.com\n")).toBe("alice@example.com");
    expect(detectLoggedInEmail("Logged in as sid.kang0129@outlook.com")).toBe(
      "sid.kang0129@outlook.com"
    );
    expect(detectLoggedInEmail("Logged in as   bob@mail.example.co.uk.  ")).toBe(
      "bob@mail.example.co.uk"
    );
    expect(detectLoggedInEmail("no identity here")).toBeUndefined();
  });
});

describe("src/accounts/auth.ts", () => {
  test("resolveAccountDescriptor defaults to host mode for empty or host auth", () => {
    const defaultDesc = resolveAccountDescriptor("agy", null);
    expect(defaultDesc.mode).toBe("host");
    expect(defaultDesc.accountRef).toBe("host");
    expect(defaultDesc.isolatedHomeDir).toBeNull();
    expect(defaultDesc.label).toBe("local-agy (host)");

    const hostDesc = resolveAccountDescriptor("agy#slot1", {
      type: "api",
      metadata: { schemaVersion: 1, accountRef: "host", mode: "host", email: "user@example.com" },
    });
    expect(hostDesc.mode).toBe("host");
    expect(hostDesc.accountRef).toBe("host");
    expect(hostDesc.label).toBe("user@example.com");
  });

  test("resolveAccountDescriptor resolves isolated accounts with UUID validation", () => {
    const isolatedDesc = resolveAccountDescriptor(`agy-isolated:${VALID_UUID}`, {
      type: "oauth",
      key: `agy-isolated:${VALID_UUID}`,
      metadata: {
        schemaVersion: 1,
        accountRef: VALID_UUID,
        mode: "isolated",
        email: "work@company.org",
      },
    });
    expect(isolatedDesc.mode).toBe("isolated");
    expect(isolatedDesc.accountRef).toBe(VALID_UUID.toLowerCase());
    expect(isolatedDesc.label).toBe("work@company.org");
    expect(isolatedDesc.isolatedHomeDir).toBe(path.join(TEST_DIR, "accounts", VALID_UUID.toLowerCase()));

    // Invalid UUID throws
    expect(() =>
      resolveAccountDescriptor("bad", {
        type: "oauth",
        key: "agy-isolated:not-a-uuid",
        metadata: { schemaVersion: 1, accountRef: "not-a-uuid", mode: "isolated" },
      })
    ).toThrow("Invalid isolated account ref");
  });

  test("extractAuthorizationCode handles both raw codes and redirect URLs", () => {
    expect(extractAuthorizationCode("  4/0AeanRawCode123  ")).toBe("4/0AeanRawCode123");

    const fullUrl =
      "https://antigravity.google/oauth-callback?code=4/0AeanUrlCode456&scope=email%20profile";
    expect(extractAuthorizationCode(fullUrl)).toBe("4/0AeanUrlCode456");

    const fullUrlWithPrefix =
      "http://localhost:8080/callback?state=xyz&code=4/0AeanUrlCode789&session=1";
    expect(extractAuthorizationCode(fullUrlWithPrefix)).toBe("4/0AeanUrlCode789");

    expect(() => extractAuthorizationCode("   ")).toThrow("Authorization code cannot be empty");
    expect(() =>
      extractAuthorizationCode("https://antigravity.google/oauth-callback?error=access_denied")
    ).toThrow("No authorization code found");
  });

  test("parseImportedAccounts supports Switcher, CLIProxyAPI, agy FileTokenStorage, plugin-auth, arrays, and lines", () => {
    // 1. Direct refresh_token JSON
    expect(
      parseImportedAccounts(JSON.stringify({ refresh_token: "1//04rtA", email: "a@example.com" }))
    ).toEqual([{ refreshToken: "1//04rtA", email: "a@example.com" }]);

    // 2. agy native antigravity-oauth-token format (only the refresh_token survives)
    expect(
      parseImportedAccounts(
        JSON.stringify({
          token: { access_token: "ya29.at", refresh_token: "1//04rtB", expires_in: 3500 },
          auth_method: "consumer",
        })
      )
    ).toEqual([{ refreshToken: "1//04rtB" }]);

    // 3. opencode-antigravity-auth / Magpie plugin-auth entry ("rt|project")
    expect(
      parseImportedAccounts(
        JSON.stringify({
          type: "oauth",
          refresh: "1//04rtC|proj-123",
          accountId: "c@example.com",
        })
      )
    ).toEqual([{ refreshToken: "1//04rtC", email: "c@example.com" }]);

    // 4. Multi-account { accounts: [...] } with deduplication
    expect(
      parseImportedAccounts(
        JSON.stringify({
          accounts: [
            { refreshToken: "1//04rt1", email: "one@example.com" },
            { refreshToken: "1//04rt2", email: "two@example.com" },
            { refreshToken: "1//04rt1", email: "dup@example.com" },
          ],
        })
      )
    ).toEqual([
      { refreshToken: "1//04rt1", email: "one@example.com" },
      { refreshToken: "1//04rt2", email: "two@example.com" },
    ]);

    // 5. Plain newline-separated refresh tokens with comments ("|project" stripped)
    expect(parseImportedAccounts("# exported\n1//04line1\n\n1//04line2|my-proj\n")).toEqual([
      { refreshToken: "1//04line1" },
      { refreshToken: "1//04line2" },
    ]);

    // 6. Rejects non-Antigravity account JSON
    expect(() =>
      parseImportedAccounts(JSON.stringify({ type: "claude", refresh_token: "1//04wrong" }))
    ).toThrow("Unsupported account type");
  });

  test("Browser loopback OAuth (method: auto) + JSON paste + file batch import (auth.import)", async () => {
    const mockFetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          expect(params.get("code_verifier")).toBeTruthy();
          expect(params.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);
          return new Response(
            JSON.stringify({
              access_token: "ya29.browser_at",
              refresh_token: "1//04browser_rt",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200 }
          );
        }
        const rt = params.get("refresh_token") ?? "";
        if (rt.includes("bad")) {
          return new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
            { status: 400 }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: `ya29.refreshed_${rt.slice(-4)}`,
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 }
        );
      }
      if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        const suffix = auth.includes("browser_at") ? "browser" : auth.slice(-4);
        return new Response(JSON.stringify({ email: `${suffix}@example.com` }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const verifyCalls: string[] = [];
    const mockVerify = async (acc: AccountDescriptor) => {
      verifyCalls.push(acc.accountRef);
      if (acc.label.includes("failverify")) {
        return { ok: false, error: "agy models verification failed" };
      }
      return { ok: true };
    };

    const methods = createAuthMethods({ fetchFn: mockFetch, verifyAccountFn: mockVerify });
    expect(methods.length).toBe(4);
    const [browserMethod, importPasteMethod, hostMethod, cliCodeMethod] = methods;
    expect(browserMethod?.label).toBe("Sign in with Google (browser)");
    expect(importPasteMethod?.label).toContain("Import an account");
    expect((hostMethod as any)?.keyless).toBe(true);
    expect(cliCodeMethod?.label).toContain("agy acp --login");

    // 1. Browser auto flow: start listener, check state mismatch + XSS escape, then complete callback
    const autoFlow = (await browserMethod!.authorize()) as any;
    expect(autoFlow.method).toBe("auto");
    const authUrl = new URL(autoFlow.url);
    expect(authUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/aicode");
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    const state = authUrl.searchParams.get("state")!;
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);

    const cbPromise = autoFlow.callback();

    // Bad state gets 400 and does NOT finish sign-in
    const badRes = await fetch(`${redirectUri}?code=bad&state=wrong`);
    expect(badRes.status).toBe(400);

    // Valid redirect (or pasted Callback URL replayed by Magpie) finishes automatically!
    const okRes = await fetch(
      `${redirectUri}?code=4/0AvalidBrowserCode&state=${encodeURIComponent(state)}`
    );
    expect(okRes.status).toBe(200);

    const browserDone = await cbPromise;
    expect(browserDone.type).toBe("success");
    expect(browserDone.accountId).toBe("browser@example.com");
    const isolatedDir = resolveIsolatedHomeDir(browserDone.metadata.accountRef);
    const tokenFile = path.join(isolatedDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    expect(fs.existsSync(tokenFile)).toBe(true);
    const savedTokenJson = JSON.parse(fs.readFileSync(tokenFile, "utf-8"));
    expect(savedTokenJson.token.refresh_token).toBe("1//04browser_rt");
    expect(savedTokenJson.auth_method).toBe("consumer");
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }

    // 2. Paste JSON import flow (`Other ways to sign in...`)
    const pasteFlow = (await importPasteMethod!.authorize({
      account: JSON.stringify({ refresh_token: "1//04paste_u1", email: "pasted@example.com" }),
    })) as any;
    expect(pasteFlow.method).toBe("auto");
    const pasteDone = await pasteFlow.callback();
    expect(pasteDone.type).toBe("success");
    expect(pasteDone.accountId).toBe("e_u1@example.com");

    // 3. Batch file import (`auth.import` — "Import from a file instead...")
    const batchResults = await importAccountFiles(
      [
        JSON.stringify({
          accounts: [
            { refresh_token: "1//04file_a1" },
            { refresh_token: "1//04bad_tok", email: "revoked@example.com" },
          ],
        }),
      ],
      undefined,
      { fetchFn: mockFetch, verifyAccountFn: mockVerify }
    );
    expect(batchResults.length).toBe(2);
    expect(batchResults[0]?.type).toBe("success");
    expect((batchResults[0] as any)?.accountId).toBe("e_a1@example.com");
    expect(batchResults[1]?.type).toBe("failed");
    expect((batchResults[1] as any)?.accountId).toBe("revoked@example.com");

    // 4. Re-importing same verified email reuses deterministic UUIDv5 (zero stranded homes)
    //    and rolls back previous token if a re-import verification fails!
    const reimportOk = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04file_a1", access_token: "ya29.stale_ignored" })],
      undefined,
      { fetchFn: mockFetch, verifyAccountFn: mockVerify }
    );
    expect(reimportOk[0]?.type).toBe("success");
    expect((reimportOk[0] as any)?.metadata.accountRef).toBe(
      (batchResults[0] as any)?.metadata.accountRef
    );
    const sameAccountTokenPath = path.join(
      resolveIsolatedHomeDir((batchResults[0] as any).metadata.accountRef),
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token"
    );
    const beforeFailReimport = fs.readFileSync(sameAccountTokenPath, "utf-8");

    const reimportFail = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04file_a1" })],
      undefined,
      {
        fetchFn: mockFetch,
        verifyAccountFn: async () => ({ ok: false, error: "simulated CLI check fail" }),
      }
    );
    expect(reimportFail[0]?.type).toBe("failed");
    expect(fs.readFileSync(sameAccountTokenPath, "utf-8")).toBe(beforeFailReimport);

    // 4b. An account directory that exists *without* a token (its credentials were
    //     removed while the directory stayed) must not keep the token a failed
    //     import just wrote: the old rollback had nothing to restore there and
    //     reported failure while leaving the new refresh token on disk.
    fs.rmSync(sameAccountTokenPath, { force: true });
    const acpStatePath = path.join(
      resolveIsolatedHomeDir((reimportOk[0] as any).metadata.accountRef),
      ".gemini",
      "antigravity-cli",
      "cache",
      "acp-auth-state.json"
    );
    const stateBefore = fs.existsSync(acpStatePath)
      ? fs.readFileSync(acpStatePath, "utf-8")
      : null;
    const reimportFailNoToken = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04file_a1" })],
      undefined,
      {
        fetchFn: mockFetch,
        verifyAccountFn: async () => ({ ok: false, error: "simulated CLI check fail" }),
      }
    );
    expect(reimportFailNoToken[0]?.type).toBe("failed");
    expect(fs.existsSync(sameAccountTokenPath)).toBe(false);
    expect(fs.existsSync(acpStatePath) ? fs.readFileSync(acpStatePath, "utf-8") : null).toBe(
      stateBefore
    );

    // 5. Truncated JSON starting with '{' fails cleanly instead of falling through to plain lines
    expect(() => parseImportedAccounts('{"refresh_token":"1//04trunc",')).toThrow("Invalid JSON");
    const badPasteFlow = (await importPasteMethod!.authorize({
      account: '{"refresh_token":"1//04trunc",',
    })) as any;
    expect(typeof badPasteFlow.callback).toBe("function");
    const badPasteRes = await badPasteFlow.callback();
    expect(badPasteRes.type).toBe("failed");

    // 6. Malformed raw HTTP request target (GET //[...] HTTP/1.1) returns 400 without crashing,
    //    and uninvoked callback listener self-closes after listenerMaxLifetimeMs!
    const net = await import("node:net");
    const shortLivedMethods = createAuthMethods({
      fetchFn: mockFetch,
      verifyAccountFn: mockVerify,
      listenerMaxLifetimeMs: 120,
    });
    const shortFlow = (await shortLivedMethods[0]!.authorize()) as any;
    const shortRedirect = new URL(shortFlow.url).searchParams.get("redirect_uri")!;
    const shortPort = Number(new URL(shortRedirect).port);

    const rawHttpReply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(shortPort, "127.0.0.1", () => {
        sock.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      sock.on("data", (c) => (data += c.toString("utf8")));
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
    });
    expect(rawHttpReply).toContain("400");

    // Without ever invoking shortFlow.callback(), wait 180ms and confirm port is closed!
    await new Promise((r) => setTimeout(r, 180));
    const stillOpen = await new Promise<boolean>((resolve) => {
      const sock = net.connect(shortPort, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    expect(stillOpen).toBe(false);

    // 7. Cancelled batch import rolls back newly created account directories and
    //    rewrites their outcomes so no `success` points at a deleted home.
    const batchAbort = new AbortController();
    let seenBatchCalls = 0;
    const abortedBatch = await importAccountFiles(
      [
        JSON.stringify({
          accounts: [{ refresh_token: "1//04abort_b1" }, { refresh_token: "1//04abort_b2" }],
        }),
      ],
      { signal: batchAbort.signal },
      {
        fetchFn: mockFetch,
        verifyAccountFn: async () => {
          seenBatchCalls++;
          if (seenBatchCalls === 2) {
            await new Promise((r) => setTimeout(r, 20));
            batchAbort.abort();
          }
          return { ok: true };
        },
      }
    );
    const b1AccountRef = accountRefFromEmail("t_b1@example.com");
    const b1Dir = path.join(TEST_DIR, "accounts", b1AccountRef);
    // b1 was already committed when the abort landed on b2, so the batch cleanup
    // rolls its home back and rewrites its `success` to `failed` (without appending
    // an extra entry for the uncommitted b2).
    expect(abortedBatch).toHaveLength(1);
    expect(abortedBatch[0]?.type).toBe("failed");
    expect((abortedBatch[0] as any)?.error).toBe("Sign-in cancelled");
    expect((abortedBatch[0] as any)?.accountId).toBe(b1AccountRef);
    expect(fs.existsSync(b1Dir)).toBe(false);

    // 8. Legacy random-UUID account loaded via resolveAccountDescriptor is reused in-place on re-import
    const legacyUuid = "22222222-3333-4444-8555-666666666666";
    resolveAccountDescriptor("agy-acp#legacy", {
      type: "api",
      key: `agy-isolated:${legacyUuid}`,
      metadata: {
        schemaVersion: 1,
        accountRef: legacyUuid,
        mode: "isolated",
        email: "y_u9@example.com",
      },
    });
    const legacyReimported = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04legacy_u9" })],
      undefined,
      { fetchFn: mockFetch, verifyAccountFn: mockVerify }
    );
    expect(legacyReimported[0]?.type).toBe("success");
    expect((legacyReimported[0] as any)?.metadata.accountRef).toBe(legacyUuid);

    // 9. Concurrent provisioning of the same email serializes cleanly (failed A never deletes B)
    let concAttempt = 0;
    const [concA, concB] = await Promise.all([
      importAccountFiles([JSON.stringify({ refresh_token: "1//04conc_c1" })], undefined, {
        fetchFn: mockFetch,
        verifyAccountFn: async () => {
          const n = ++concAttempt;
          if (n === 1) {
            await new Promise((r) => setTimeout(r, 40));
            return { ok: false, error: "first attempt failed" };
          }
          return { ok: true };
        },
      }),
      importAccountFiles([JSON.stringify({ refresh_token: "1//04conc_c1" })], undefined, {
        fetchFn: mockFetch,
        verifyAccountFn: async () => {
          const n = ++concAttempt;
          if (n === 1) {
            await new Promise((r) => setTimeout(r, 40));
            return { ok: false, error: "first attempt failed" };
          }
          return { ok: true };
        },
      }),
    ]);
    const outcomes = [concA[0]!, concB[0]!];
    expect(outcomes.some((o) => o.type === "failed")).toBe(true);
    expect(outcomes.some((o) => o.type === "success")).toBe(true);
    const c1Dir = path.join(TEST_DIR, "accounts", accountRefFromEmail("c_c1@example.com"));
    expect(fs.existsSync(path.join(c1Dir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))).toBe(
      true
    );
  });

  test("mid-batch abort keeps an updated pre-existing account's success and its directory", async () => {
    // The minted access_token encodes the refresh-token suffix so userinfo can
    // answer with a stable, per-token email address.
    const emailFor = (refreshToken: string): string => `${refreshToken.slice(-4)}@example.com`;
    const mockFetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        const refreshToken = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
        return new Response(
          JSON.stringify({ access_token: `ya29.${refreshToken.slice(-4)}`, expires_in: 3600 }),
          { status: 200 }
        );
      }
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ email: `${authorization.slice(-4)}@example.com` }), {
        status: 200,
      });
    }) as typeof fetch;

    // Seed one committed account so the batch below updates a pre-existing home.
    const seeded = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04exist_u1" })],
      undefined,
      { fetchFn: mockFetch, verifyAccountFn: async () => ({ ok: true }) }
    );
    expect(seeded[0]?.type).toBe("success");
    const existingRef = (seeded[0] as any).metadata.accountRef;
    const existingDir = path.join(TEST_DIR, "accounts", existingRef);
    const existingStamp = path.join(existingDir, ".commit-stamp");
    const existingToken = path.join(
      existingDir,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token"
    );
    expect(fs.existsSync(existingStamp)).toBe(true);

    const batchAbort = new AbortController();
    let verifyCalls = 0;
    const mixedBatch = await importAccountFiles(
      [
        JSON.stringify({
          accounts: [
            { refresh_token: "1//04exist_u1" },
            { refresh_token: "1//04fresh_u2" },
            { refresh_token: "1//04abort_u3" },
          ],
        }),
      ],
      { signal: batchAbort.signal },
      {
        fetchFn: mockFetch,
        verifyAccountFn: async () => {
          if (++verifyCalls === 3) {
            await new Promise((r) => setTimeout(r, 20));
            batchAbort.abort();
          }
          return { ok: true };
        },
      }
    );

    const freshRef = accountRefFromEmail(emailFor("1//04fresh_u2"));
    expect(mixedBatch.length).toBe(2);
    // The account that already existed keeps its `success` and its committed home.
    expect(mixedBatch[0]?.type).toBe("success");
    expect((mixedBatch[0] as any)?.metadata.accountRef).toBe(existingRef);
    expect(fs.existsSync(existingStamp)).toBe(true);
    expect(fs.existsSync(existingToken)).toBe(true);

    // The newly created account committed before abort was rolled back and rewritten.
    expect(mixedBatch[1]).toEqual({
      type: "failed",
      error: "Sign-in cancelled",
      accountId: freshRef,
    });
    expect(fs.existsSync(path.join(TEST_DIR, "accounts", freshRef))).toBe(false);
  });

  test("createAuthMethods registers terminal code OAuth and Host API methods", async () => {
    const methods = createAuthMethods();
    expect(methods.length).toBe(4);

    const hostMethod = methods[2]!;
    const oauthMethod = methods[3]!;
    expect(oauthMethod.type).toBe("oauth");
    expect(oauthMethod.label).toContain("agy acp --login");
    expect(hostMethod.type).toBe("api");
    expect(hostMethod.label).toContain("local agy login");

    // SAFETY RULE CHECK: Use mock agy binary, never invoke real /opt/homebrew/bin/agy acp --login!
    const mockAgyPath = path.join(TEST_DIR, "mock-agy.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code"
  read line
  mkdir -p "$3"
  touch "$3/session.json"
  exit 0
fi

if [ "$1" = "models" ]; then
  echo "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)"
  exit 0
fi

exit 1
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const flow = await oauthMethod.authorize({ label: "test-auth-user" });
      expect("url" in flow).toBe(true);
      if ("type" in flow && flow.type === "failed") {
        throw new Error(flow.error);
      }
      const oauthResult = flow as any;
      expect(oauthResult.url).toContain("https://accounts.google.com/o/oauth2/auth");
      expect(oauthResult.method).toBe("code");

      const cbResult = await oauthResult.callback("mock-auth-code-12345");
      expect(cbResult.type).toBe("success");
      if (cbResult.type === "success") {
        expect(cbResult.metadata.mode).toBe("isolated");
        expect(cbResult.metadata.label).toBe("test-auth-user");
        expect(cbResult.metadata.email).toMatch(/^test-auth-user \([0-9a-f]{8}\)$/);
      }

      // A second `callback()` is refused instead of throwing: Magpie retries pastes.
      expect(await oauthResult.callback("code-again")).toEqual({
        type: "failed",
        error: "Callback has already been invoked",
      });

      const hostAdopt = (await hostMethod.authorize()) as { type: string; metadata?: any };
      expect(hostAdopt.type).toBe("success");
      expect(hostAdopt.metadata?.mode).toBe("host");
    });
  });

  test("createAuthMethods redacts OAuth secrets from a failing agy sign-in output", async () => {
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-auth-leak.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "fatal: code=4/0AeanLeakedAuthCode1234567890 access_token=ya29.secretToken123" >&2
  exit 3
fi
exit 1
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const oauthMethod = createAuthMethods()[3]!;
      const flow = (await oauthMethod.authorize()) as { type: string; error?: string };
      expect(flow.type).toBe("failed");
      const error = flow.error ?? "";
      expect(error).toContain("before printing sign-in URL");
      expect(error).toContain("[REDACTED]");
      expect(error).not.toContain("4/0AeanLeakedAuthCode1234567890");
      expect(error).not.toContain("ya29.secretToken123");
    });
  });

  test("createAuthMethods redacts secrets from agy models verification failures", async () => {
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-auth-verify-leak.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code"
  read line
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "error: access_token=ya29.verifySecret refresh_token=1//04verifySecret" >&2
  exit 1
fi
exit 1
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const oauthMethod = createAuthMethods()[3]!;
      const flow = (await oauthMethod.authorize()) as any;
      expect(flow.method).toBe("code");
      const result = await flow.callback("mock-auth-code-12345");
      expect(result.type).toBe("failed");
      expect(result.error).toContain("Verification failed");
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).not.toContain("ya29.verifySecret");
      expect(result.error).not.toContain("1//04verifySecret");
    });
  });

  test("a failed file-lock acquisition does not wedge the in-memory provisioning lock", async () => {
    const email = "lock_release_d1@example.com";
    const accountRef = accountRefFromEmail(email);

    const lockFetch = (async (input: any, _init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "ya29.lock_release", expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const accountsDir = path.join(TEST_DIR, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    const lockPath = path.join(accountsDir, `${accountRef}.lock`);
    // A lock owned by THIS live pid is never swept, so acquisition must time out.
    fs.writeFileSync(lockPath, `${process.pid}:test-held-lock\n`, { mode: 0o600 });

    const deps = {
      fetchFn: lockFetch,
      verifyAccountFn: async () => ({ ok: true }),
      accountFileLockTimeoutMs: 150,
    };

    const lockFailure = await importAccountFiles(
      [JSON.stringify({ refresh_token: "1//04lock_release_d1" })], undefined, deps
    );
    expect(lockFailure[0]?.type).toBe("failed");
    expect((lockFailure[0] as any)?.error).toContain("Timed out waiting for concurrent sign-in lock");

    // The stale lock is gone: the same account must provision instead of hanging
    // forever behind the leaked in-memory lock.
    fs.rmSync(lockPath, { force: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deadlocked = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(
        () => reject(new Error("provisioning deadlocked on accountProvisionLocks")),
        5_000
      );
    });
    let retried: Awaited<ReturnType<typeof importAccountFiles>>;
    try {
      retried = await Promise.race([
        importAccountFiles(
          [JSON.stringify({ refresh_token: "1//04lock_release_d1" })],
          undefined,
          deps
        ),
        deadlocked,
      ]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    expect(retried[0]?.type).toBe("success");
    expect((retried[0] as any)?.metadata?.accountRef).toBe(accountRef);
    expect(fs.existsSync(path.join(accountsDir, accountRef, ".commit-stamp"))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("aborting the terminal code flow after the URL is returned kills agy and rolls back the temp account", async () => {
    const pidFile = path.join(TEST_DIR, "mock-agy-terminal-pid.txt");
    fs.rmSync(pidFile, { force: true });
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-terminal-abandon.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code"
  echo $$ > "${pidFile}"
  read line
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)"
  exit 0
fi
exit 1
`,
      { mode: 0o755 }
    );

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (probe: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
      const startedAt = Date.now();
      for (;;) {
        if (probe()) return true;
        if (Date.now() - startedAt > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const accountsDir = path.join(TEST_DIR, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    const dirsBefore = new Set(fs.readdirSync(accountsDir));
    const controller = new AbortController();
    let childPid = 0;

    try {
      await withEnv({ AGY_PATH: mockAgyPath }, async () => {
        const oauthMethod = createAuthMethods()[3]!;
        const flow = (await (oauthMethod as any).authorize(undefined, {
          signal: controller.signal,
        })) as any;
        expect(flow.method).toBe("code");
        expect(flow.url).toContain("https://accounts.google.com/o/oauth2/auth");

        const createdDirs = fs
          .readdirSync(accountsDir)
          .filter((name) => !dirsBefore.has(name));
        expect(createdDirs).toHaveLength(1);
        const tempDir = path.join(accountsDir, createdDirs[0]!);
        expect(fs.existsSync(tempDir)).toBe(true);

        expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
        childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        expect(childPid).toBeGreaterThan(1);
        expect(isAlive(childPid)).toBe(true);

        // Abandon the sign-in: the URL was handed to the user, `callback` never runs.
        controller.abort();

        expect(await waitFor(() => !isAlive(childPid))).toBe(true);
        expect(await waitFor(() => !fs.existsSync(tempDir))).toBe(true);
      });
    } finally {
      // Never leave a stray mock `agy acp --login` behind, even when an assertion fails.
      if (childPid > 1 && isAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
  });

  test("the terminal code flow timeout also reaps an abandoned agy login", async () => {
    const pidFile = path.join(TEST_DIR, "mock-agy-terminal-timeout-pid.txt");
    fs.rmSync(pidFile, { force: true });
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-terminal-timeout.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code"
  echo $$ > "${pidFile}"
  read line
  exit 0
fi
exit 1
`,
      { mode: 0o755 }
    );

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (probe: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
      const startedAt = Date.now();
      for (;;) {
        if (probe()) return true;
        if (Date.now() - startedAt > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const accountsDir = path.join(TEST_DIR, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    const dirsBefore = new Set(fs.readdirSync(accountsDir));
    let childPid = 0;

    try {
      await withEnv({ AGY_PATH: mockAgyPath }, async () => {
        const oauthMethod = createAuthMethods({ terminalFlowTimeoutMs: 800 })[3]!;
        const flow = (await (oauthMethod as any).authorize()) as any;
        expect(flow.method).toBe("code");

        const createdDirs = fs
          .readdirSync(accountsDir)
          .filter((name) => !dirsBefore.has(name));
        expect(createdDirs).toHaveLength(1);
        const tempDir = path.join(accountsDir, createdDirs[0]!);
        expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
        childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        expect(isAlive(childPid)).toBe(true);

        expect(await waitFor(() => !isAlive(childPid))).toBe(true);
        expect(await waitFor(() => !fs.existsSync(tempDir))).toBe(true);
      });
    } finally {
      // Never leave a stray mock `agy acp --login` behind, even when an assertion fails.
      if (childPid > 1 && isAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
  });
});

describe("src/usage/catalog.ts", () => {
  test("parseAgyModelsOutput correctly parses real agy 1.5.7 output and skips header", () => {
    const rawList = parseAgyModelsOutput(REAL_AGY_MODELS_OUTPUT);
    expect(rawList.length).toBe(22);
    expect(rawList[0]?.rawModelId).toBe("gemini-4-carbon-medium");
    expect(rawList[0]?.displayName).toBe("Gemini 4 Carbon (Medium)");
    expect(rawList.find((m) => m.rawModelId.startsWith("Fetching"))).toBeUndefined();
  });

  test("buildCatalog groups families and variants accurately", () => {
    const rawList = parseAgyModelsOutput(REAL_AGY_MODELS_OUTPUT);
    const catalog = buildCatalog(rawList);

    expect(catalog.rawIds.size).toBe(22);

    // gemini-3.8-flash has low, medium, high
    const flashRoute = catalog.routes.get("gemini-3.8-flash");
    expect(flashRoute).toBeDefined();
    expect(flashRoute?.efforts).toEqual(["low", "medium", "high"]);
    expect(flashRoute?.defaultEffort).toBe("medium");
    expect(flashRoute?.byEffort.get("low")).toBe("gemini-3.8-flash-low");
    expect(flashRoute?.byEffort.get("medium")).toBe("gemini-3.8-flash-medium");
    expect(flashRoute?.byEffort.get("high")).toBe("gemini-3.8-flash-high");

    // gemini-4-hydrogen has low, medium, high, xhigh
    const hydrogenRoute = catalog.routes.get("gemini-4-hydrogen");
    expect(hydrogenRoute).toBeDefined();
    expect(hydrogenRoute?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(hydrogenRoute?.defaultEffort).toBe("medium");

    // claude-opus-5-5 has low, medium, high
    const opusRoute = catalog.routes.get("claude-opus-5-5");
    expect(opusRoute).toBeDefined();
    expect(opusRoute?.efforts).toEqual(["low", "medium", "high"]);

    // gpt-oss-120b: exposes collapsed family gpt-oss-120b (no duplicate gpt-oss-120b-medium in models)
    expect(catalog.routes.has("gpt-oss-120b")).toBe(true);
    expect(catalog.models.some((m) => m.id === "gpt-oss-120b")).toBe(true);
    expect(catalog.models.some((m) => m.id === "gpt-oss-120b-medium")).toBe(false);
    expect(catalog.models.some((m) => m.id === "gemini-3.8-flash-low")).toBe(false);

    // Standalone models: gemini-pro-orchestrator, gemini-pro-orchestrator-argon
    expect(catalog.models.some((m) => m.id === "gemini-pro-orchestrator")).toBe(true);
    expect(catalog.models.some((m) => m.id === "gemini-pro-orchestrator-argon")).toBe(true);
  });

  test("resolveRequestedModel resolves by family, effort override, inline effort, and exact raw ID", () => {
    const rawList = parseAgyModelsOutput(REAL_AGY_MODELS_OUTPUT);
    const catalog = buildCatalog(rawList);

    // Family default effort -> medium
    const flashDefault = resolveRequestedModel("gemini-3.8-flash", catalog);
    expect(flashDefault).toEqual({
      rawModelId: "gemini-3.8-flash-medium",
      configModelValue: "gemini-3.8-flash",
      effort: "medium",
    });

    // Family with effort override -> low
    const flashLow = resolveRequestedModel("gemini-3.8-flash", catalog, "low");
    expect(flashLow).toEqual({
      rawModelId: "gemini-3.8-flash-low",
      configModelValue: "gemini-3.8-flash",
      effort: "low",
    });

    // Family with inline effort :high
    const flashHighInline = resolveRequestedModel("gemini-3.8-flash:high", catalog);
    expect(flashHighInline).toEqual({
      rawModelId: "gemini-3.8-flash-high",
      configModelValue: "gemini-3.8-flash",
      effort: "high",
    });

    // Exact raw ID request
    const exactRaw = resolveRequestedModel("gemini-3.8-flash-low", catalog);
    expect(exactRaw?.rawModelId).toBe("gemini-3.8-flash-low");
    expect(exactRaw?.effort).toBe("low");

    // gemini-4-hydrogen xhigh
    const hydrogenXHigh = resolveRequestedModel("gemini-4-hydrogen", catalog, "xhigh");
    expect(hydrogenXHigh?.rawModelId).toBe("gemini-4-hydrogen-xhigh");
    expect(hydrogenXHigh?.effort).toBe("xhigh");

    // Standalone model
    const orchestrator = resolveRequestedModel("gemini-pro-orchestrator", catalog);
    expect(orchestrator).toEqual({
      rawModelId: "gemini-pro-orchestrator",
      configModelValue: "gemini-pro-orchestrator",
      effort: undefined,
    });

    // gpt-oss-120b family and raw
    const gptFamily = resolveRequestedModel("gpt-oss-120b", catalog);
    expect(gptFamily?.rawModelId).toBe("gpt-oss-120b-medium");
    const gptRaw = resolveRequestedModel("gpt-oss-120b-medium", catalog);
    expect(gptRaw?.rawModelId).toBe("gpt-oss-120b-medium");

    // Magpie's 1M-context suffix is not part of the agy model id.
    const opus1m = resolveRequestedModel("claude-opus-5-5-low[1m]", catalog);
    expect(opus1m?.rawModelId).toBe("claude-opus-5-5-low");
    const orchestrator1m = resolveRequestedModel("gemini-pro-orchestrator[1m]", catalog);
    expect(orchestrator1m?.rawModelId).toBe("gemini-pro-orchestrator");
    const flashFamily1m = resolveRequestedModel("gemini-3.8-flash[1m]", catalog, "low");
    expect(flashFamily1m?.rawModelId).toBe("gemini-3.8-flash-low");
  });

  test("closestEffort picks closest effort in EFFORT_ORDER", () => {
    // ["low", "high"] requested "medium" -> picks "high" (or nearest)
    expect(closestEffort("medium", ["low", "high"])).toBe("high");
    // ["minimal", "low"] requested "high" -> picks "low"
    expect(closestEffort("high", ["minimal", "low"])).toBe("low");
    // Exact match
    expect(closestEffort("xhigh", ["low", "medium", "xhigh"])).toBe("xhigh");
  });

  test("getModelLimits and buildProviderModels configure Magpie metadata properly", () => {
    expect(getModelLimits("gemini-3.8-flash")).toEqual({ context: 1048576, output: 65536 });
    expect(getModelLimits("gemini-4-hydrogen-high")).toEqual({ context: 1048576, output: 65536 });
    expect(getModelLimits("gemini-4-carbon")).toEqual({ context: 1048576, output: 262144 });
    expect(getModelLimits("claude-opus-5-5")).toEqual({ context: 1000000, output: 64000 });
    expect(getModelLimits("gpt-oss-120b")).toEqual({ context: 131072, output: 32768 });

    const rawList = parseAgyModelsOutput(REAL_AGY_MODELS_OUTPUT);
    const catalog = buildCatalog(rawList);
    const providerModels = buildProviderModels(catalog);

    // gemini-3.8-flash entry
    const flash = providerModels["gemini-3.8-flash"];
    expect(flash).toBeDefined();
    expect(flash?.npm).toBe("@ai-sdk/anthropic");
    expect(flash?.api.url).toBe("agy://local");
    expect(flash?.capabilities.attachment).toBe(true);
    expect(flash?.capabilities.reasoning).toBe(true);
    expect(flash?.variants).toEqual({ low: {}, medium: {}, high: {} });

    // Collapsed family list omits raw effort variants unless includeRawIds: true
    expect(providerModels["gpt-oss-120b"]?.variants).toEqual({ medium: {} });
    expect(providerModels["gpt-oss-120b-medium"]).toBeUndefined();
    expect(providerModels["gemini-3.8-flash-low"]).toBeUndefined();
  });

  test("buildProviderModels marks fallback catalogs with Magpie's non-enumerable fellBack symbol", () => {
    const rawList = parseAgyModelsOutput(REAL_AGY_MODELS_OUTPUT);
    const fellBackKey = Symbol.for("magpie.fellBack");
    const fresh = buildProviderModels(buildCatalog(rawList)) as unknown as Record<string | symbol, unknown>;
    expect(fresh[fellBackKey]).toBeUndefined();

    const marked = buildProviderModels(buildCatalog(rawList), { fellBack: true }) as unknown as Record<
      string | symbol,
      unknown
    >;
    expect(marked[fellBackKey]).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(marked, fellBackKey);
    expect(descriptor?.enumerable).toBe(false);

    const staticModels = buildProviderModels(getStaticFallbackCatalog()) as unknown as Record<string | symbol, unknown>;
    expect(staticModels[fellBackKey]).toBe(true);
  });

  test("CatalogService returns fallback catalog when CLI is uninitialized or times out", async () => {
    const service = new CatalogService();
    const staticCatalog = getStaticFallbackCatalog();
    expect(staticCatalog.isFallback).toBe(true);
    expect(staticCatalog.routes.has("gemini-4-argon")).toBe(true);

    const hostAccount: AccountDescriptor = {
      slotKey: "test-host",
      accountRef: "host",
      mode: "host",
      label: "Host Test",
      isolatedHomeDir: null,
    };

    // Fast resolution with static fallback when CLI is slow/mocked
    const cat = await service.getCatalog(hostAccount);
    expect(cat).toBeDefined();
    expect(cat.models.length).toBeGreaterThan(0);
  });

  test("CatalogService scopes its cache and single-flight by accountRef, not just slotKey", async () => {
    const modelsFile = path.join(TEST_DIR, "catalog-switch.txt");
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-catalog-switch.sh");
    fs.writeFileSync(mockAgyPath, `#!/bin/sh\ncat "${modelsFile}"\n`, { mode: 0o755 });

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const slotKey = "shared-catalog-slot";
      const accountA: AccountDescriptor = {
        slotKey,
        accountRef: VALID_UUID,
        mode: "isolated",
        label: "Catalog A",
        isolatedHomeDir: resolveIsolatedHomeDir(VALID_UUID),
      };
      const accountB: AccountDescriptor = {
        slotKey,
        accountRef: OTHER_UUID,
        mode: "isolated",
        label: "Catalog B",
        isolatedHomeDir: resolveIsolatedHomeDir(OTHER_UUID),
      };

      fs.writeFileSync(
        modelsFile,
        "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n"
      );
      const service = new CatalogService();
      const catalogA = await service.getCatalog(accountA);
      expect(catalogA.isFallback).toBe(false);
      expect(catalogA.rawIds.has("gemini-4-argon-medium")).toBe(true);

      // Same slotKey, re-authenticated against a different isolated account.
      fs.writeFileSync(
        modelsFile,
        "claude-opus-5-5-high\tClaude Opus 5.5 (High)\n"
      );
      const catalogB = await service.getCatalog(accountB);
      expect(catalogB.isFallback).toBe(false);
      expect(catalogB.rawIds.has("claude-opus-5-5-high")).toBe(true);
      expect(catalogB.rawIds.has("gemini-4-argon-medium")).toBe(false);

      // Account A still reads its own cache entry, not B's.
      const catalogAAgain = await service.getCatalog(accountA);
      expect(catalogAAgain.rawIds.has("gemini-4-argon-medium")).toBe(true);
      expect(catalogAAgain.rawIds.has("claude-opus-5-5-high")).toBe(false);
    });
  });
});

describe("src/usage/quota.ts", () => {
  test("formatCodeAssistPlan formats tier names and preserves non-duplicated multipliers", () => {
    expect(
      formatCodeAssistPlan({ paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" } }),
    ).toBe("Google AI Ultra");
    expect(
      formatCodeAssistPlan({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }),
    ).toBe("Google AI Pro");
    expect(
      formatCodeAssistPlan({ currentTier: { id: "free-tier", name: "Antigravity" } }),
    ).toBe("Free");
    expect(
      formatCodeAssistPlan({ currentTier: { id: "standard-tier", name: "Antigravity" } }),
    ).toBe("Standard");
    expect(
      formatCodeAssistPlan({ paidTier: { id: "max_5x", name: "Max" } }),
    ).toBe("Max 5x");
    expect(
      formatCodeAssistPlan({ paidTier: { id: "g1-ultra-20x", name: "Google AI Ultra" } }),
    ).toBe("Google AI Ultra 20x");
    expect(
      formatCodeAssistPlan({ paidTier: { id: "max_20x", name: "Max 20x" } }),
    ).toBe("Max 20x");
  });

  test("cadence and reset time parse correctly", () => {
    expect(cadence({ window: "5h" }, "5h", "").span).toBe(18000);
    expect(cadence({ window: "weekly" }, "weekly", "").span).toBe(604800);
    expect(cadence({}, "custom", "Custom Window").span).toBeUndefined();

    expect(parseResetTime("1793059200")).toBe("2026-10-27T00:00:00.000Z");
    expect(parseResetTime("2026-11-14T07:57:52Z")).toBe("2026-11-14T07:57:52.000Z");
    expect(parseResetTime("invalid-time")).toBeUndefined();
    expect(parseResetTime(null)).toBeUndefined();
  });

  test("parseUsageReport parses real agy 1.5.7 JSON output", () => {
    const catalogModelIds = [
      "gemini-3.8-flash",
      "gemini-3.8-flash-low",
      "gemini-4-hydrogen",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-oss-120b",
    ];

    // quotaRouting: false -> aside: true
    const resNoQr = parseUsageReport(REAL_USAGE_JSON, catalogModelIds, { quotaRouting: false });
    expect(resNoQr.windows.length).toBe(4);
    expect(resNoQr.windows.every((w) => w.aside === true)).toBe(true);

    // Check Gemini 5h bucket: remaining 0.77066 -> used = (1 - 0.77066) * 100 = 22.9%
    const gemini5h = resNoQr.windows.find((w) => w.pool === "Gemini" && w.name === "5 hours");
    expect(gemini5h).toBeDefined();
    expect(gemini5h?.pool).toBe("Gemini");
    expect(gemini5h?.used).toBe(22.9);
    expect(gemini5h?.span).toBe(18000);
    expect(gemini5h?.resetsAt).toBe("2026-11-13T04:25:05.000Z");
    expect(gemini5h?.models).toBeUndefined();

    // Check Claude & GPT weekly bucket: remaining 1.0 -> used = 0%
    const claudeWeekly = resNoQr.windows.find((w) => w.pool === "Claude & GPT" && w.name === "7 days");
    expect(claudeWeekly).toBeDefined();
    expect(claudeWeekly?.pool).toBe("Claude & GPT");
    expect(claudeWeekly?.used).toBe(0);
    expect(claudeWeekly?.span).toBe(604800);
    expect(claudeWeekly?.models).toBeUndefined();

    // quotaRouting: true -> aside: false
    const resQr = parseUsageReport(REAL_USAGE_JSON, catalogModelIds, { quotaRouting: true });
    expect(resQr.windows.every((w) => w.aside === false)).toBe(true);
    expect(resQr.windows.find((w) => w.pool === "Gemini")?.models).toEqual([
      "gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-4-hydrogen",
    ]);
    expect(resQr.windows.find((w) => w.pool === "Claude & GPT")?.models).toEqual([
      "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b",
    ]);
  });

  test("parseUsageReport handles missing/null remaining_fraction with display message and aside: true", () => {
    const unmeasuredReport = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.8,
                  reset_time: "2026-11-14T07:57:52Z",
                },
                {
                  id: "gemini-weekly",
                  name: "Weekly Limit",
                  window: "weekly",
                  remaining_fraction: null,
                  reset_time: "2026-11-14T07:57:52Z",
                },
              ],
            },
          ],
        },
      },
    };

    const res = parseUsageReport(unmeasuredReport, ["gemini-3.8-flash"], { quotaRouting: true });
    expect(res.windows.length).toBe(2);

    const measured = res.windows[0]!;
    expect(measured.used).toBe(20);
    expect(measured.aside).toBe(false);

    const unmeasured = res.windows[1]!;
    expect(unmeasured.used).toBeNull();
    expect(unmeasured.display).toBe("Limits not available");
    expect(unmeasured.aside).toBe(true); // Always true for unmeasured
  });

  test("parseUsageReport keeps fractional precision and never rounds a partially exhausted bucket to 100", () => {
    const report = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-nearly-empty",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.004,
                },
                {
                  id: "gemini-empty",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0,
                },
              ],
            },
          ],
        },
      },
    };

    const res = parseUsageReport(report, ["gemini-3.8-flash"], { quotaRouting: true });
    const nearlyEmpty = res.windows.find((w) => w.name === "5 hours");
    expect(nearlyEmpty?.used).toBe(99.6);
    expect(nearlyEmpty?.used).toBeLessThan(100);
    expect(res.windows.find((w) => w.name === "7 days")?.used).toBe(100);
  });

  test("parseUsageReport leaves a pool with no matching catalog models aside even with quotaRouting", () => {
    const report = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Comet Models",
              buckets: [
                {
                  id: "comet-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0,
                },
              ],
            },
          ],
        },
      },
    };

    const res = parseUsageReport(report, ["gemini-3.8-flash"], { quotaRouting: true });
    expect(res.windows).toHaveLength(1);
    expect(res.windows[0]?.models).toBeUndefined();
    expect(res.windows[0]?.aside).toBe(true);
  });

  test("queryAccountUsage single-flights and caches results for 30 seconds", async () => {
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-usage.sh");
    const fixturePath = path.join(TEST_DIR, "usage-fixture.json");
    fs.writeFileSync(fixturePath, JSON.stringify(REAL_USAGE_JSON));

    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
cat "${fixturePath}"
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const account: AccountDescriptor = {
        slotKey: "quota-test-slot",
        accountRef: "host",
        mode: "host",
        label: "Quota Test",
        isolatedHomeDir: null,
      };

      // Call twice concurrently
      const [r1, r2] = await Promise.all([
        queryAccountUsage(account, ["gemini-3.8-flash"], { quotaRouting: false }),
        queryAccountUsage(account, ["gemini-3.8-flash"], { quotaRouting: false }),
      ]);

      expect(r1.signIn).toBe("kept");
      expect(r2.signIn).toBe("kept");
      expect(r1.windows.length).toBe(4);
      expect(r2.windows.length).toBe(4);

      // Third call should be served from 30s cache
      const r3 = await queryAccountUsage(account, ["gemini-3.8-flash"], { quotaRouting: false });
      expect(r3.windows.length).toBe(4);
    });
  });

  test("queryAccountUsage detects authentication expiration", async () => {
    const mockExpiredAgy = path.join(TEST_DIR, "mock-agy-expired.sh");
    fs.writeFileSync(
      mockExpiredAgy,
      `#!/bin/sh
echo "Error: authentication expired. Please sign in again." >&2
exit 1
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockExpiredAgy }, async () => {
      const account: AccountDescriptor = {
        slotKey: "expired-test-slot",
        accountRef: "host",
        mode: "host",
        label: "Expired Test",
        isolatedHomeDir: null,
      };

      const result = await queryAccountUsage(account, [], { quotaRouting: false });
      expect(result.signIn).toBe("expired");
      expect(result.windows).toEqual([]);
      expect(result.error).toContain("authentication expired");
    });
  });

  test("queryAccountUsage scopes cache and single-flight by accountRef, not just slotKey", async () => {
    const fixturePath = path.join(TEST_DIR, "quota-switch.json");
    fs.writeFileSync(fixturePath, JSON.stringify(REAL_USAGE_JSON));
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-quota-switch.sh");
    fs.writeFileSync(mockAgyPath, `#!/bin/sh\ncat "${fixturePath}"\n`, { mode: 0o755 });

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const slotKey = "shared-quota-slot";
      const accountA: AccountDescriptor = {
        slotKey,
        accountRef: VALID_UUID,
        mode: "isolated",
        label: "Quota A",
        isolatedHomeDir: resolveIsolatedHomeDir(VALID_UUID),
      };
      const accountB: AccountDescriptor = {
        slotKey,
        accountRef: OTHER_UUID,
        mode: "isolated",
        label: "Quota B",
        isolatedHomeDir: resolveIsolatedHomeDir(OTHER_UUID),
      };

      const resultA = await queryAccountUsage(accountA, [], { quotaRouting: false });
      expect(resultA.signIn).toBe("kept");
      expect(resultA.windows.length).toBe(4);

      // Same slotKey, re-authenticated against a different isolated account.
      const smallerReport = {
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.5,
                    reset_time: "2026-11-14T07:57:52Z",
                  },
                ],
              },
            ],
          },
        },
      };
      fs.writeFileSync(fixturePath, JSON.stringify(smallerReport));

      const resultB = await queryAccountUsage(accountB, [], { quotaRouting: false });
      expect(resultB.signIn).toBe("kept");
      expect(resultB.windows.length).toBe(1);

      // Account A is still served from its own cached result.
      const resultAAgain = await queryAccountUsage(accountA, [], { quotaRouting: false });
      expect(resultAAgain.windows.length).toBe(4);
    });
  });

  test("queryAccountUsage does not cache expired or failed results", async () => {
    const fixturePath = path.join(TEST_DIR, "quota-expiry.json");
    const failFlag = path.join(TEST_DIR, "quota-expiry.flag");
    fs.writeFileSync(fixturePath, JSON.stringify(REAL_USAGE_JSON));
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-quota-expiry.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ -f "${failFlag}" ]; then
  echo "Error: authentication expired. Please sign in again." >&2
  exit 1
fi
cat "${fixturePath}"
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const account: AccountDescriptor = {
        slotKey: "expiry-retry-slot",
        accountRef: "host",
        mode: "host",
        label: "Expiry Retry",
        isolatedHomeDir: null,
      };

      fs.writeFileSync(failFlag, "1");
      const expired = await queryAccountUsage(account, [], { quotaRouting: false });
      expect(expired.signIn).toBe("expired");

      // A stale "expired" status must not stick for 30s after a fresh sign-in.
      fs.rmSync(failFlag);
      const recovered = await queryAccountUsage(account, [], { quotaRouting: false });
      expect(recovered.signIn).toBe("kept");
      expect(recovered.windows.length).toBe(4);
    });
  });

  test("queryAccountUsage redacts secrets from failed agy output", async () => {
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-quota-leak.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
echo "refresh_token=1//04secretToken code=4/0AeanLeakedQuotaCode1234567890" >&2
exit 1
`,
      { mode: 0o755 }
    );

    await withEnv({ AGY_PATH: mockAgyPath }, async () => {
      const account: AccountDescriptor = {
        slotKey: "redact-quota-slot",
        accountRef: "host",
        mode: "host",
        label: "Redact Quota",
        isolatedHomeDir: null,
      };

      const result = await queryAccountUsage(account, [], { quotaRouting: false });
      expect(result.signIn).toBe("kept");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).not.toContain("1//04secretToken");
      expect(result.error).not.toContain("4/0AeanLeakedQuotaCode1234567890");
    });
  });
});

describe("src/usage/step-usage.ts", () => {
  test("reads gen_metadata from both live WAL and checkpointed WAL SQLite stores without creating sidecars", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    const convDir = path.join(TEST_DIR, "sqlite-conversations");
    fs.mkdirSync(convDir, { recursive: true });
    const sessionId = "check-wal-session-01";
    const dbPath = path.join(convDir, `${sessionId}.db`);

    function encodeVarint(n: number): number[] {
      const out: number[] = [];
      let v = n;
      while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      out.push(v);
      return out;
    }
    const usageMsg = Buffer.from([
      (2 << 3) | 0,
      ...encodeVarint(23406),
      (3 << 3) | 0,
      ...encodeVarint(42),
      (5 << 3) | 0,
      ...encodeVarint(20415),
      (9 << 3) | 0,
      ...encodeVarint(18),
    ]);
    const inner = Buffer.concat([
      Buffer.from([(4 << 3) | 2, ...encodeVarint(usageMsg.length)]),
      usageMsg,
    ]);
    const outer = Buffer.concat([
      Buffer.from([(1 << 3) | 2, ...encodeVarint(inner.length)]),
      inner,
    ]);

    const writer = new Database(dbPath);
    writer.exec("PRAGMA journal_mode = WAL;");
    writer.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
    writer
      .prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
      .run(0, outer);

    const prevDir = process.env.AGY_BRIDGE_CONVERSATIONS_DIR;
    process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir;
    const account: AccountDescriptor = {
      slotKey: "agy-acp",
      accountRef: "host",
      mode: "host",
      label: "host",
      isolatedHomeDir: null,
    };

    try {
      const liveSteps = readConversationStepUsages(account, sessionId);
      expect(liveSteps).toEqual([
        {
          idx: 0,
          input: 23406,
          output: 42,
          write: 0,
          read: 20415,
          thinking: 18,
        },
      ]);

      writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      writer.close();
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
      const closedSteps = readConversationStepUsages(account, sessionId);
      expect(closedSteps).toEqual(liveSteps);
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      if (prevDir !== undefined) {
        process.env.AGY_BRIDGE_CONVERSATIONS_DIR = prevDir;
      } else {
        delete process.env.AGY_BRIDGE_CONVERSATIONS_DIR;
      }
    }
  });
});

describe("src/options.ts", () => {
  test("buildProviderOptionSchemas defaults match readProviderOptions fallbacks", async () => {
    const schemas = buildProviderOptionSchemas();
    expect(schemas.map((schema) => schema.key)).toEqual([
      "quota_routing",
      "account_failover",
      "cloak_prompts",
      "minimal_agent",
      "expose_thinking",
    ]);

    // Clear the env overrides so the schema defaults and the state fallbacks are
    // compared on their own, without a shell-level AGY_MAGPIE_* skewing one side.
    await withEnv(
      {
        AGY_MAGPIE_QUOTA_ROUTING: undefined,
        AGY_MAGPIE_ACCOUNT_FAILOVER: undefined,
        AGY_MAGPIE_CLOAK_PROMPTS: undefined,
        AGY_MAGPIE_MINIMAL_AGENT: undefined,
        AGY_MAGPIE_EXPOSE_THINKING: undefined,
      },
      () => {
        const defaults = readProviderOptions({}, undefined);
        expect(defaults).toEqual({
          quotaRouting: true,
          // The pool does not walk itself: a failed account's error comes back.
          accountFailover: false,
          // Cloaking is off by default: it works around a vendor check.
          cloakPrompts: false,
          minimalAgent: false,
          exposeThinking: true,
          cloakSaidAs: "",
        });

        expect(readProviderOptions({}, { quota_routing: false }).quotaRouting).toBe(false);
        expect(readProviderOptions({ magpie: { option: () => false } }).quotaRouting).toBe(false);
        const defaultByKey: Record<string, boolean> = {
          quota_routing: defaults.quotaRouting,
          account_failover: defaults.accountFailover,
          cloak_prompts: defaults.cloakPrompts,
          minimal_agent: defaults.minimalAgent,
          expose_thinking: defaults.exposeThinking,
        };
        expect(schemas.map((schema) => schema.default)).toEqual(
          schemas.map((schema) => defaultByKey[schema.key]!)
        );
      }
    );
  });
});


async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeProbe(name: string, body: string): string {
  const bin = path.join(TEST_DIR, name);
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

function testAccount(slotKey: string, withCredentials = false): AccountDescriptor {
  const accountRef = crypto.randomUUID();
  const home = resolveIsolatedHomeDir(accountRef);
  if (withCredentials) fs.writeFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ access_token: "test-access", expiry: new Date(Date.now() + 3_600_000).toISOString() }));
  return { slotKey, accountRef, mode: "isolated", label: slotKey, isolatedHomeDir: home };
}

function importFetch(emailFor: (token: string) => string): typeof fetch {
  return (async (input: any, init: any) => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      const token = new URLSearchParams(init.body).get("refresh_token")!;
      return Response.json({ access_token: token, expires_in: 3600 });
    }
    return Response.json({ email: emailFor(new Headers(init.headers).get("Authorization")!.slice(7)) });
  }) as typeof fetch;
}

describe("Slice A routing and concurrency regressions", () => {
  test("specific pools claim only their models before broad pools, preserving report order", () => {
    const group = (name: string) => ({ name, buckets: [{ id: "5h", window: "5h", remaining_fraction: 0 }] });
    const ids = ["gemini-4-argon", "gemini-4-argon-high", "gemini-pro-orchestrator-argon",
      "gemini-3.8-flash-low", "gemini-4-carbon-high", "gemini-4-hydrogen-low",
      "gemini-pro-orchestrator", "claude-opus-5-5", "gpt-oss-120b"];
    const report = { status: "SUCCESS", command: { name: "usage", data: { groups: [
      group(" Gemini   Models "), group("Gemini 4 Argon Models"), group("Claude and GPT models"),
      group("Claude"), group("GPT"), group("Unknown"),
      { name: "Gemini 4 Carbon" }, // Invalid groups cannot steal broad-pool models.
    ] } } };
    const { windows } = parseUsageReport(report, ids, { quotaRouting: true });
    expect(windows.map((w) => w.pool)).toEqual(["Gemini", "Gemini 4 Argon", "Claude & GPT", "Claude", "GPT", "Unknown"]);
    expect(windows[0]?.models).toEqual(ids.slice(3, 7));
    expect(windows[1]?.models).toEqual(ids.slice(0, 3));
    expect(windows[1]?.name).toBe("5 hours");
    expect(windows[2]?.models).toEqual(ids.slice(7));
    expect(windows[3]?.models).toEqual([ids[7]!]);
    expect(windows[4]?.models).toEqual([ids[8]!]);
    expect(windows[5]?.aside).toBe(true);
    expect(windows[5]?.models).toBeUndefined();
    expect(windows.every((w) => w.aside || !!w.models?.length)).toBe(true);

    report.command.data.groups = [group("Gemini 4"), group("Gemini 4 Argon"), group("Gemini Models")];
    const overlap = parseUsageReport(report, ids, { quotaRouting: true }).windows;
    expect(overlap[0]?.models).toEqual(ids.slice(4, 6));
    expect(overlap[1]?.models).toEqual(ids.slice(0, 3));
    expect(overlap[2]?.models).toEqual([ids[3]!, ids[6]!]);
    const unknown = group("Gemini");
    (unknown.buckets[0] as any).remaining_fraction = null;
    report.command.data.groups = [unknown];
    expect(() => parseUsageReport(report, ids, { quotaRouting: true })).toThrow("no enabled, measured");
  });

  test("usage cache tracks catalog attribution and clones every caller's windows and model lists", async () => {
    const log = path.join(TEST_DIR, "catalog-key.log");
    const bin = writeProbe("catalog-key-probe", `
      const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "probe\\n");
      setTimeout(() => console.log(${JSON.stringify(JSON.stringify(REAL_USAGE_JSON))}), 40);
    `);
    await withEnv({ AGY_PATH: bin }, async () => {
      const account = testAccount("catalog-key");
      const ids = ["gemini-4-argon", "gemini-3.8-flash"];
      const [a, b] = await Promise.all([
        queryAccountUsage(account, ids, { quotaRouting: true }),
        queryAccountUsage(account, ids, { quotaRouting: true }),
      ]);
      a.windows[0]!.models!.push("mutation");
      a.windows[0]!.used = 100;
      expect(b.windows[0]?.models).toEqual(ids);
      expect(b.windows[0]?.used).not.toBe(100);
      const cached = await queryAccountUsage(account, [ids[1]!, ids[0]!, ids[0]!], { quotaRouting: true });
      expect(cached.windows[0]?.models).toEqual(ids);
      cached.windows.length = 0;
      expect((await queryAccountUsage(account, ids, { quotaRouting: true })).windows).toHaveLength(4);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      const live = await queryAccountUsage(account, [ids[1]!], { quotaRouting: true });
      expect(live.windows[0]?.models).toEqual([ids[1]!]);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    });
  });

  test("probe semaphore caps six children at two and removes aborted/expired queued probes", async () => {
    const log = path.join(TEST_DIR, "semaphore.log");
    const bin = writeProbe("semaphore-probe", `
      const fs = require("node:fs"); const id = process.argv[2];
      fs.appendFileSync(${JSON.stringify(log)}, "start " + id + "\\n");
      setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, "end " + id + "\\n"); }, 180);
    `);
    await withEnv({ AGY_PATH: bin, AGY_ACP_MAX_CONCURRENT_PROBES: "2" }, async () => {
      const account = testAccount("semaphore");
      const runs = Array.from({ length: 6 }, (_, i) => execAgyBounded(account, [String(i)], { timeoutMs: 3_000 }));
      await waitUntil(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("start 1"));
      const abort = new AbortController();
      const cancelled = execAgyBounded(account, ["aborted"], { signal: abort.signal, timeoutMs: 2_000 });
      const expired = execAgyBounded(account, ["expired"], { timeoutMs: 30 });
      abort.abort();
      const abortResult = await cancelled;
      expect(abortResult).toEqual({ exitCode: null, stdout: "", stderr: "", timedOut: false });
      expect((await expired).timedOut).toBe(true);
      const pre = new AbortController(); pre.abort();
      expect((await execAgyBounded(account, ["pre-aborted"], { signal: pre.signal })).timedOut).toBe(false);
      expect((await execAgyBounded(account, ["zero"], { timeoutMs: 0 })).timedOut).toBe(true);
      expect((await Promise.all(runs)).every((r) => r.exitCode === 0)).toBe(true);
      let active = 0, peak = 0;
      const events = fs.readFileSync(log, "utf8").trim().split("\n");
      for (const event of events) { active += event.startsWith("start") ? 1 : -1; peak = Math.max(peak, active); }
      expect(peak).toBe(2);
      expect(active).toBe(0);
      expect(events).toHaveLength(12);
      expect(events.join("\n")).not.toMatch(/aborted|expired|zero/);
    });
  });

  test("probe slots stay FIFO, include queue time in execution deadlines, and recover after spawn/overflow failures", async () => {
    const log = path.join(TEST_DIR, "fifo-probes.log");
    const bin = writeProbe("fifo-probe", `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");
      if (process.argv[2] === "overflow") process.stdout.write("x".repeat(4096));
      setTimeout(() => console.log("done"), Number(process.argv[3] || 0));
    `);
    await withEnv({ AGY_PATH: bin, AGY_ACP_MAX_CONCURRENT_PROBES: "1" }, async () => {
      const account = testAccount("fifo-probes");
      const first = execAgyBounded(account, ["first", "150"]);
      await waitUntil(() => fs.existsSync(log));
      const second = execAgyBounded(account, ["second", "0"]);
      const third = execAgyBounded(account, ["third", "0"]);
      expect((await Promise.all([first, second, third])).every((r) => r.exitCode === 0)).toBe(true);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["first", "second", "third"]);
      const blocker = execAgyBounded(account, ["blocker", "200"]);
      await waitUntil(() => fs.readFileSync(log, "utf8").includes("blocker"));
      const budgeted = execAgyBounded(account, ["budgeted", "200"], { timeoutMs: 300 });
      expect((await blocker).exitCode).toBe(0);
      expect((await budgeted).timedOut).toBe(true);
      expect((await execAgyBounded(account, ["overflow", "1000"], { maxBytes: 10 })).exitCode).toBeNull();
      await withEnv({ AGY_PATH: path.join(TEST_DIR, "nonexistent-probe") }, async () => {
        expect((await execAgyBounded(account, [])).exitCode).toBe(-1);
      });
      const invalid = path.join(TEST_DIR, "invalid-executable");
      fs.writeFileSync(invalid, "not executable", { mode: 0o600 });
      await withEnv({ AGY_PATH: invalid }, async () => {
        expect((await execAgyBounded(account, [])).exitCode).toBeNull();
      });
      // The granted-but-not-yet-spawned cancellation must release its slot too.
      const abort = new AbortController();
      const granted = execAgyBounded(account, ["must-not-spawn"], { signal: abort.signal });
      abort.abort();
      expect((await granted).timedOut).toBe(false);
      expect((await execAgyBounded(account, ["recovered"])).exitCode).toBe(0);
      expect(fs.readFileSync(log, "utf8")).not.toContain("must-not-spawn");
    });
  });

  test("invalid probe-limit strings fall back to six instead of accepting numeric prefixes", async () => {
    const log = path.join(TEST_DIR, "default-limit.log");
    const gate = path.join(TEST_DIR, "default-limit.gate");
    const bin = writeProbe("default-limit-probe", `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(log)}, "start\\n");
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(timer);
      }, 5);
    `);
    await withEnv({ AGY_PATH: bin, AGY_ACP_MAX_CONCURRENT_PROBES: "02" }, async () => {
      const account = testAccount("default-limit");
      const probes = Array.from({ length: 7 }, () => execAgyBounded(account, [], { timeoutMs: 3_000 }));
      try {
        await waitUntil(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").trim().split("\n").length >= 6);
        expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(6);
      } finally { fs.writeFileSync(gate, "release"); }
      expect((await Promise.all(probes)).every((r) => r.exitCode === 0)).toBe(true);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(7);
    });
  });

  test("parallel import stays within four workers and preserves source order around errors", async () => {
    let active = 0, peak = 0;
    const outcomes = await importAccountFiles([
      '{"refresh_token":"order-0"}', "{", '{"accounts":[{"refresh_token":"order-1"},{"refresh_token":"order-2"}]}',
      '{}', ...Array.from({ length: 6 }, (_, i) => JSON.stringify({ refresh_token: `order-${i + 3}` })),
    ], undefined, {
      fetchFn: importFetch((token) => `${token}@example.com`),
      verifyAccountFn: async (account) => {
        active++; peak = Math.max(peak, active);
        const i = Number(account.label.match(/order-(\d+)/)![1]);
        await new Promise((r) => setTimeout(r, i === 0 ? 60 : 5));
        active--; return { ok: true };
      },
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(outcomes.map((o) => o.type === "success" ? o.accountId : "error")).toEqual([
      "order-0@example.com", "error", "order-1@example.com", "order-2@example.com", "error",
      ...Array.from({ length: 6 }, (_, i) => `order-${i + 3}@example.com`),
    ]);
  });

  test("import's 100-slot limit counts errors and unique tokens in source order", async () => {
    let calls = 0;
    const outcomes = await importAccountFiles(["{", JSON.stringify({ accounts: [
      { refresh_token: "limit-0" }, { refresh_token: "limit-0" },
      ...Array.from({ length: 105 }, (_, i) => ({ refresh_token: `limit-${i + 1}` })),
    ] }), "{"], undefined, {
      importConcurrency: 16,
      fetchFn: importFetch((token) => `${token}@example.com`),
      verifyAccountFn: async () => { calls++; return { ok: true }; },
    });
    expect(outcomes).toHaveLength(100);
    expect(outcomes[0]?.type).toBe("failed");
    expect(outcomes[99]?.accountId).toBe("limit-98@example.com");
    expect(calls).toBe(99);
  });

  test("abort rolls back every committed same-email token and waits for simultaneous in-flight tasks", async () => {
    const abort = new AbortController();
    const pendingStarted = new Set<string>();
    let finishSlow!: () => void;
    const slowGate = new Promise<void>((r) => { finishSlow = r; });
    let slowFinished = false;
    const emailFor = (token: string) => token.startsWith("dup-") ? "batch-duplicate@example.com" : `${token}@example.com`;
    const batch = importAccountFiles([JSON.stringify({ accounts: [
      "dup-a", "dup-b", "slow-a", "slow-b", "unstarted",
    ].map((refresh_token) => ({ refresh_token })) })], { signal: abort.signal }, {
      importConcurrency: 2,
      fetchFn: importFetch(emailFor),
      verifyAccountFn: async (account, signal) => {
        if (account.label.startsWith("slow-")) {
          pendingStarted.add(account.label);
          await slowGate; // Deliberately ignores abort until the test permits completion.
          slowFinished = true;
          expect(signal?.aborted).toBe(true);
        }
        return { ok: true };
      },
    });
    const dupRef = accountRefFromEmail(emailFor("dup-a"));
    const dupDir = path.join(TEST_DIR, "accounts", dupRef);
    const tokenFile = path.join(dupDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    await waitUntil(() => pendingStarted.size === 2 && fs.existsSync(tokenFile) &&
      fs.readFileSync(tokenFile, "utf8").includes("dup-b") && fs.existsSync(path.join(dupDir, ".commit-stamp")));
    // Both workers reached their next slot, so both same-email commits are complete.
    abort.abort();
    let settled = false; void batch.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    finishSlow();
    const results = await batch;
    expect(slowFinished).toBe(true);
    expect(results).toEqual([
      { type: "failed", error: "Sign-in cancelled", accountId: dupRef },
      { type: "failed", error: "Sign-in cancelled", accountId: dupRef },
    ]);
    for (const email of [emailFor("dup-a"), emailFor("slow-a"), emailFor("slow-b"), emailFor("unstarted")]) {
      expect(fs.existsSync(path.join(TEST_DIR, "accounts", accountRefFromEmail(email)))).toBe(false);
    }
  });

  test("aborted import lock waiter detaches promptly without bypassing a live predecessor", async () => {
    let release!: () => void;
    let verifies = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = {
      fetchFn: importFetch(() => "abort-lock@example.com"),
      verifyAccountFn: async () => { verifies++; await gate; return { ok: true }; },
    };
    const first = importAccountFiles('{"refresh_token":"lock-a"}', undefined, deps);
    await waitUntil(() => verifies === 1);
    const abort = new AbortController();
    const second = importAccountFiles('{"refresh_token":"lock-b"}', { signal: abort.signal }, deps);
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    expect(await second).toEqual([]);
    const third = importAccountFiles('{"refresh_token":"lock-c"}', undefined, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(verifies).toBe(1);
    release();
    expect((await first)[0]?.type).toBe("success");
    expect((await third)[0]?.type).toBe("success");
  });

  test("abort cleanup preserves accounts touched by another batch between same-email commits", async () => {
    const abort = new AbortController();
    const email = "externally-touched@example.com";
    const baseFetch = importFetch(() => email);
    let externalRef = "";
    const deps = {
      importConcurrency: 1,
      fetchFn: (async (input: any, init: any) => {
        if (String(input).includes("oauth2.googleapis.com/token") &&
            new URLSearchParams(init.body).get("refresh_token") === "external-second") {
          const outside = await importAccountFiles('{"refresh_token":"external-outside"}', undefined, {
            fetchFn: baseFetch, verifyAccountFn: async () => ({ ok: true }),
          });
          externalRef = (outside[0] as any).metadata.accountRef;
        }
        return baseFetch(input, init);
      }) as typeof fetch,
      verifyAccountFn: async (account: AccountDescriptor) => {
        const token = readStoredAgyOAuthCredentials(account)?.refreshToken;
        if (token === "external-abort") abort.abort();
        return { ok: true };
      },
    };
    const results = await importAccountFiles(JSON.stringify({ accounts: [
      "external-first", "external-second", "external-abort",
    ].map((refresh_token) => ({ refresh_token })) }), { signal: abort.signal }, deps);
    expect(externalRef).toBe(accountRefFromEmail(email));
    expect(results.map((r) => r.type)).toEqual(["success", "success"]);
    const dir = path.join(TEST_DIR, "accounts", externalRef);
    expect(fs.existsSync(path.join(dir, ".commit-stamp"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8"))
      .toContain("external-second");
  });

  test("abort cleanup surfaces deletion failures instead of reporting clean cancellation", async () => {
    const abort = new AbortController();
    const firstRef = accountRefFromEmail("cleanup-first@example.com");
    const firstDir = path.join(TEST_DIR, "accounts", firstRef);
    const originalRm = fs.rmSync;
    fs.rmSync = ((target: fs.PathLike, options: any) => {
      if (String(target) === firstDir) throw new Error("simulated rollback failure");
      return originalRm(target, options);
    }) as typeof fs.rmSync;
    try {
      const results = await importAccountFiles(JSON.stringify({ accounts: [
        { refresh_token: "cleanup-first" }, { refresh_token: "cleanup-abort" },
      ] }), { signal: abort.signal }, {
        importConcurrency: 1,
        fetchFn: importFetch((token) => `${token}@example.com`),
        verifyAccountFn: async (account) => {
          if (account.label === "cleanup-abort@example.com") abort.abort();
          return { ok: true };
        },
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe("failed");
      expect((results[0] as any).error).toContain("Sign-in cancellation cleanup failed: simulated rollback failure");
      expect(fs.existsSync(firstDir)).toBe(true);
    } finally {
      fs.rmSync = originalRm;
      fs.rmSync(firstDir, { recursive: true, force: true });
    }
  });

  test("abort also interrupts cross-process file-lock polling without deleting its owner's lock", async () => {
    const email = "file-lock-abort@example.com";
    const lockPath = path.join(TEST_DIR, "accounts", `${accountRefFromEmail(email)}.lock`);
    fs.writeFileSync(lockPath, `${process.pid}:live-owner\n`);
    const abort = new AbortController();
    let verified = false;
    try {
      const batch = importAccountFiles('{"refresh_token":"file-lock-abort"}', { signal: abort.signal }, {
        fetchFn: importFetch(() => email),
        verifyAccountFn: async () => { verified = true; return { ok: true }; },
      });
      await new Promise((r) => setTimeout(r, 20));
      abort.abort();
      expect(await batch).toEqual([]);
      expect(verified).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:live-owner\n`);
    } finally { fs.rmSync(lockPath, { force: true }); }
  });

  test("usage waiters isolate cancellation, abandon all-cancelled flights, and start fresh immediately", async () => {
    const log = path.join(TEST_DIR, "usage-abort.log");
    const bin = writeProbe("usage-abort-probe", `
      require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + "\\n");
      setTimeout(() => console.log(${JSON.stringify(JSON.stringify(REAL_USAGE_JSON))}), 180);
    `);
    await withEnv({ AGY_PATH: bin }, async () => {
      const account = testAccount("usage-abort");
      const a = new AbortController();
      const one = queryAccountUsage(account, ["gemini-4-argon"], { quotaRouting: true, signal: a.signal });
      const two = queryAccountUsage(account, ["gemini-4-argon"], { quotaRouting: true });
      await waitUntil(() => fs.existsSync(log));
      a.abort();
      expect((await one).error).toBe("Usage query cancelled");
      expect((await two).windows).toHaveLength(4);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

      const another = testAccount("usage-abandon");
      const b = new AbortController(), c = new AbortController();
      const three = queryAccountUsage(another, [], { quotaRouting: true, signal: b.signal });
      const four = queryAccountUsage(another, [], { quotaRouting: true, signal: c.signal });
      await waitUntil(() => fs.readFileSync(log, "utf8").trim().split("\n").length === 2);
      const killedPid = Number(fs.readFileSync(log, "utf8").trim().split("\n")[1]);
      b.abort(); c.abort();
      const fresh = queryAccountUsage(another, [], { quotaRouting: true });
      expect((await three).error).toBe("Usage query cancelled");
      expect((await four).error).toBe("Usage query cancelled");
      expect((await fresh).error).toBeUndefined();
      await waitUntil(() => { try { process.kill(killedPid, 0); return false; } catch { return true; } });
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
      const pre = new AbortController(); pre.abort();
      expect((await queryAccountUsage(testAccount("pre-abort"), [], { quotaRouting: true, signal: pre.signal })).error)
        .toBe("Usage query cancelled");
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
    });
  });

  test("plan waiters isolate abort and abandon only when every active caller leaves", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ signal: AbortSignal; finish: () => void }> = [];
    globalThis.fetch = ((_: any, init: any) => new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      requests.push({ signal, finish: () => resolve(Response.json({ paidTier: { name: "Test Pro" } })) });
      if (signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    try {
      const account = testAccount("plan-abort", true);
      const a = new AbortController();
      const one = queryAccountPlan(account, a.signal);
      const two = queryAccountPlan(account);
      await waitUntil(() => requests.length === 1);
      a.abort();
      expect(await one).toBeUndefined();
      expect(requests[0]!.signal.aborted).toBe(false);
      requests[0]!.finish();
      expect(await two).toBe("Test Pro");
      const other = testAccount("plan-abandon", true);
      const b = new AbortController(), c = new AbortController();
      const three = queryAccountPlan(other, b.signal), four = queryAccountPlan(other, c.signal);
      await waitUntil(() => requests.length === 2);
      b.abort(); c.abort();
      expect(requests[1]!.signal.aborted).toBe(true);
      const fresh = queryAccountPlan(other);
      expect(await three).toBeUndefined(); expect(await four).toBeUndefined();
      await waitUntil(() => requests.length === 3);
      requests[2]!.finish();
      expect(await fresh).toBe("Test Pro");
      const pre = new AbortController(); pre.abort();
      expect(await queryAccountPlan(testAccount("plan-pre", true), pre.signal)).toBeUndefined();
      expect(requests).toHaveLength(3);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("abandoning usage does not cancel an independent plan waiter", async () => {
    const bin = writeProbe("usage-plan-abort-probe", "setTimeout(() => {}, 1000);");
    const originalFetch = globalThis.fetch;
    let planSignal: AbortSignal | undefined;
    let finish!: () => void;
    globalThis.fetch = ((_: any, init: any) => new Promise<Response>((resolve) => {
      planSignal = init.signal;
      finish = () => resolve(Response.json({ paidTier: { name: "Independent Pro" } }));
    })) as typeof fetch;
    try {
      await withEnv({ AGY_PATH: bin }, async () => {
        const account = testAccount("usage-plan-abort", true);
        const abort = new AbortController();
        const usage = queryAccountUsage(account, [], { quotaRouting: true, signal: abort.signal });
        const plan = queryAccountPlan(account);
        await waitUntil(() => !!planSignal);
        abort.abort();
        expect((await usage).error).toBe("Usage query cancelled");
        expect(planSignal!.aborted).toBe(false);
        finish();
        expect(await plan).toBe("Independent Pro");
      });
    } finally { globalThis.fetch = originalFetch; }
  });
});
