import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AccountDescriptor } from "../src/types";
import {
  buildAgyEnvAndArgs,
  getBrowserShimDir,
  getPluginDataRoot,
  killProcessTree,
  readStoredAgyOAuthCredentials,
  redactSecrets,
  resolveAgyBinary,
  resolveIsolatedHomeDir,
  sweepStaleAccountStorage,
} from "../src/accounts/env";
import {
  createAuthMethods,
  extractAuthorizationCode,
  importAccountFiles,
  parseImportedAccounts,
  resolveAccountDescriptor,
  writeIsolatedAgyOAuthToken,
} from "../src/accounts/auth";
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
} from "../src/usage/quota";
import { readConversationStepUsages } from "../src/usage/step-usage";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-accounts-usage-test-"));
const ORIGINAL_DATA_DIR = process.env.ANTIGRAVITY_MAGPIE_DATA_DIR;
const ORIGINAL_AGY_PATH = process.env.AGY_PATH;

const VALID_UUID = "e2b65597-96a9-46be-8f3e-52ebc689b7b9";
const OTHER_UUID = "0f6d9d0a-0c4f-4f52-9a3f-2f0b4c1d2e3a";

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
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = TEST_DIR;
});

afterAll(() => {
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

  test("buildAgyEnvAndArgs sets up isolated environment correctly", () => {
    const isolatedAccount: AccountDescriptor = {
      slotKey: `agy-isolated:${VALID_UUID}`,
      accountRef: VALID_UUID,
      mode: "isolated",
      label: "test-isolated",
      isolatedHomeDir: resolveIsolatedHomeDir(VALID_UUID),
    };

    // Set cross-contaminating env vars to check that they get purged
    process.env.GEMINI_API_KEY = "polluted-gemini";
    process.env.GOOGLE_API_KEY = "polluted-google";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "polluted-creds";
    process.env.ANTIGRAVITY_APP_DATA_DIR = "polluted-app-data";
    process.env.ANTIGRAVITY_CONFIG_REL_DIR = "polluted-config-rel";

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
    expect(acpResult.env.XDG_CONFIG_HOME).toBe(path.join(isolatedAccount.isolatedHomeDir!, ".config"));

    // Verify args for `acp` have absolute --gemini-dir and relative --app-data-dir
    expect(acpResult.finalArgs[0]).toBe("acp");
    const geminiIdx = acpResult.finalArgs.indexOf("--gemini-dir");
    expect(geminiIdx).toBeGreaterThan(0);
    expect(acpResult.finalArgs[geminiIdx + 1]).toBe(path.join(isolatedAccount.isolatedHomeDir!, ".gemini"));
    const appDataIdx = acpResult.finalArgs.indexOf("--app-data-dir");
    expect(appDataIdx).toBeGreaterThan(0);
    expect(acpResult.finalArgs[appDataIdx + 1]).toBe("antigravity-cli");
    expect(path.isAbsolute(acpResult.finalArgs[appDataIdx + 1]!)).toBe(false);

    // Verify args for `models` do NOT append --gemini-dir
    const modelsResult = buildAgyEnvAndArgs(isolatedAccount, ["models"]);
    expect(modelsResult.finalArgs).toEqual(["models"]);

    // Clean up test pollution
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_REL_DIR;
  });

  test("buildAgyEnvAndArgs keeps loopback out of proxies and applies Magpie proxy fallbacks", () => {
    const isolatedAccount: AccountDescriptor = {
      slotKey: `agy-isolated:${OTHER_UUID}`,
      accountRef: OTHER_UUID,
      mode: "isolated",
      label: "proxy-test",
      isolatedHomeDir: resolveIsolatedHomeDir(OTHER_UUID),
    };

    const prev = {
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      ALL_PROXY: process.env.ALL_PROXY,
      all_proxy: process.env.all_proxy,
      MAGPIE_HTTPS_PROXY: process.env.MAGPIE_HTTPS_PROXY,
      MAGPIE_HTTP_PROXY: process.env.MAGPIE_HTTP_PROXY,
      MAGPIE_ALL_PROXY: process.env.MAGPIE_ALL_PROXY,
    };
    try {
      process.env.NO_PROXY = "example.com,localhost";
      delete process.env.no_proxy;
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.HTTP_PROXY;
      delete process.env.http_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
      process.env.MAGPIE_HTTPS_PROXY = "http://proxy.example:8443";
      process.env.MAGPIE_HTTP_PROXY = "http://proxy.example:8080";
      process.env.MAGPIE_ALL_PROXY = "socks5://proxy.example:1080";

      const result = buildAgyEnvAndArgs(isolatedAccount, ["models"]);

      expect(result.env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1");
      expect(result.env.no_proxy).toBe("127.0.0.1,localhost,::1");
      expect(result.env.HTTPS_PROXY).toBe("http://proxy.example:8443");
      expect(result.env.HTTP_PROXY).toBe("http://proxy.example:8080");
      expect(result.env.ALL_PROXY).toBe("socks5://proxy.example:1080");
      expect(result.env.USERPROFILE).toBe(isolatedAccount.isolatedHomeDir!);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("buildAgyEnvAndArgs preserves host settings for host accounts", () => {
    const hostAccount: AccountDescriptor = {
      slotKey: "agy",
      accountRef: "host",
      mode: "host",
      label: "local-agy (host)",
      isolatedHomeDir: null,
    };

    const result = buildAgyEnvAndArgs(hostAccount, ["models"]);
    expect(result.env.SSH_CONNECTION).toBe(process.env.SSH_CONNECTION);
    expect(result.finalArgs).toEqual(["models"]);
    expect(result.env.BROWSER).toBe("/usr/bin/false");
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

  test("sweepStaleAccountStorage prunes stale unprotected artifacts and preserves protected and fresh ones", () => {
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

    const prevAgyAcpDataDir = process.env.AGY_ACP_DATA_DIR;
    process.env.AGY_ACP_DATA_DIR = tempDataDir;
    try {
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
    } finally {
      if (prevAgyAcpDataDir !== undefined) {
        process.env.AGY_ACP_DATA_DIR = prevAgyAcpDataDir;
      } else {
        delete process.env.AGY_ACP_DATA_DIR;
      }
    }
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

    // 2. agy native antigravity-oauth-token format
    expect(
      parseImportedAccounts(
        JSON.stringify({
          token: { access_token: "ya29.at", refresh_token: "1//04rtB", expires_in: 3500 },
          auth_method: "consumer",
        })
      )
    ).toEqual([{ refreshToken: "1//04rtB", accessToken: "ya29.at", expiresIn: 3500 }]);

    // 3. opencode-antigravity-auth / Magpie plugin-auth entry ("rt|project")
    expect(
      parseImportedAccounts(
        JSON.stringify({
          type: "oauth",
          refresh: "1//04rtC|proj-123",
          accountId: "c@example.com",
        })
      )
    ).toEqual([{ refreshToken: "1//04rtC", project: "proj-123", email: "c@example.com" }]);

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

    // 5. Plain newline-separated refresh tokens with comments
    expect(parseImportedAccounts("# exported\n1//04line1\n\n1//04line2|my-proj\n")).toEqual([
      { refreshToken: "1//04line1" },
      { refreshToken: "1//04line2", project: "my-proj" },
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

    // 7. Cancelled batch import rolls back newly created account directories
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
          if (seenBatchCalls === 2) batchAbort.abort();
          return { ok: true };
        },
      }
    );
    expect(abortedBatch.length).toBe(1);
    const { accountRefFromEmail } = await import("../src/accounts/auth");
    const b1Dir = path.join(TEST_DIR, "accounts", accountRefFromEmail("t_b1@example.com"));
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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

      await expect(oauthResult.callback("code-again")).rejects.toThrow(
        "Callback has already been invoked"
      );

      const hostAdopt = (await hostMethod.authorize()) as { type: string; metadata?: any };
      expect(hostAdopt.type).toBe("success");
      expect(hostAdopt.metadata?.mode).toBe("host");
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
      const oauthMethod = createAuthMethods()[3]!;
      const flow = (await oauthMethod.authorize()) as { type: string; error?: string };
      expect(flow.type).toBe("failed");
      const error = flow.error ?? "";
      expect(error).toContain("before printing sign-in URL");
      expect(error).toContain("[REDACTED]");
      expect(error).not.toContain("4/0AeanLeakedAuthCode1234567890");
      expect(error).not.toContain("ya29.secretToken123");
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
      const oauthMethod = createAuthMethods()[3]!;
      const flow = (await oauthMethod.authorize()) as any;
      expect(flow.method).toBe("code");
      const result = await flow.callback("mock-auth-code-12345");
      expect(result.type).toBe("failed");
      expect(result.error).toContain("Verification failed");
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).not.toContain("ya29.verifySecret");
      expect(result.error).not.toContain("1//04verifySecret");
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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
    expect(gemini5h?.models).toEqual(["gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-4-hydrogen"]);

    // Check Claude & GPT weekly bucket: remaining 1.0 -> used = 0%
    const claudeWeekly = resNoQr.windows.find((w) => w.pool === "Claude & GPT" && w.name === "7 days");
    expect(claudeWeekly).toBeDefined();
    expect(claudeWeekly?.pool).toBe("Claude & GPT");
    expect(claudeWeekly?.used).toBe(0);
    expect(claudeWeekly?.span).toBe(604800);
    expect(claudeWeekly?.models).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]);

    // quotaRouting: true -> aside: false
    const resQr = parseUsageReport(REAL_USAGE_JSON, catalogModelIds, { quotaRouting: true });
    expect(resQr.windows.every((w) => w.aside === false)).toBe(true);
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockExpiredAgy;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
  });

  test("queryAccountUsage scopes cache and single-flight by accountRef, not just slotKey", async () => {
    const fixturePath = path.join(TEST_DIR, "quota-switch.json");
    fs.writeFileSync(fixturePath, JSON.stringify(REAL_USAGE_JSON));
    const mockAgyPath = path.join(TEST_DIR, "mock-agy-quota-switch.sh");
    fs.writeFileSync(mockAgyPath, `#!/bin/sh\ncat "${fixturePath}"\n`, { mode: 0o755 });

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

    const prevAgy = process.env.AGY_PATH;
    process.env.AGY_PATH = mockAgyPath;

    try {
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
    } finally {
      if (prevAgy) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
    }
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

