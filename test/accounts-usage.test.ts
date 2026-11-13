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
  redactSecrets,
  resolveAgyBinary,
  resolveIsolatedHomeDir,
} from "../src/accounts/env";
import {
  createAuthMethods,
  extractAuthorizationCode,
  resolveAccountDescriptor,
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
  parseResetTime,
  parseUsageReport,
  queryAccountUsage,
} from "../src/usage/quota";

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

    // Verify args for `acp` have --gemini-dir and --app-data-dir
    expect(acpResult.finalArgs[0]).toBe("acp");
    expect(acpResult.finalArgs).toContain("--gemini-dir");
    expect(acpResult.finalArgs).toContain(path.join(isolatedAccount.isolatedHomeDir!, ".gemini"));
    expect(acpResult.finalArgs).toContain("--app-data-dir");

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

  test("createAuthMethods registers OAuth and Host API methods", async () => {
    const methods = createAuthMethods();
    expect(methods.length).toBe(2);

    const [oauthMethod, hostMethod] = methods;
    expect(oauthMethod?.type).toBe("oauth");
    expect(oauthMethod?.label).toContain("isolated Google account");
    expect(hostMethod?.type).toBe("api");
    expect(hostMethod?.label).toContain("local agy login");

    // SAFETY RULE CHECK: Use mock agy binary, never invoke real /opt/homebrew/bin/agy acp --login!
    const mockAgyPath = path.join(TEST_DIR, "mock-agy.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/sh
if [ "$1" = "acp" ]; then
  echo "https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code"
  read line
  # $3 is geminiDir from --gemini-dir <path>
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
      // Test OAuth login flow
      const flow = await oauthMethod!.authorize({ label: "test-auth-user" });
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
      }

      // Verify single-use callback guard
      await expect(oauthResult.callback("code-again")).rejects.toThrow(
        "Callback has already been invoked"
      );

      // Test host adoption method
      const hostAdopt = (await hostMethod!.authorize()) as { type: string; metadata?: any };
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
      const [oauthMethod] = createAuthMethods();
      const flow = (await oauthMethod!.authorize()) as { type: string; error?: string };
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
      const [oauthMethod] = createAuthMethods();
      const flow = (await oauthMethod!.authorize()) as any;
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

    // gpt-oss-120b: exposes BOTH gpt-oss-120b and gpt-oss-120b-medium
    expect(catalog.routes.has("gpt-oss-120b")).toBe(true);
    expect(catalog.models.some((m) => m.id === "gpt-oss-120b")).toBe(true);
    expect(catalog.models.some((m) => m.id === "gpt-oss-120b-medium")).toBe(true);

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

    // gpt-oss-120b-medium entry
    const gptRaw = providerModels["gpt-oss-120b-medium"];
    expect(gptRaw).toBeDefined();
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

    // Check Gemini 5h bucket: remaining 0.77066 -> used = round((1 - 0.77066) * 100) = 23%
    const gemini5h = resNoQr.windows.find((w) => w.pool === "Gemini" && w.name === "5 hours");
    expect(gemini5h).toBeDefined();
    expect(gemini5h?.pool).toBe("Gemini");
    expect(gemini5h?.used).toBe(23);
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
