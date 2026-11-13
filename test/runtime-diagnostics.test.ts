import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AccountDescriptor, TurnStreamEvent } from "../src/types";
import { LoopbackMcpServer } from "../src/mcp/http-server";
import {
  SIGN_IN_HEADER,
  encodeAnthropicSseResponse,
} from "../src/protocol/anthropic";
import { AgySessionWorker } from "../src/runtime/worker";
import {
  CONTEXT_BUDGET_FAILURE_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  TurnLogWatch,
  classifyAgentFailure,
  extractErrorEvidence,
  stderrDelta,
} from "../src/runtime/diagnostics";

const TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "agy-runtime-diagnostics-test-"),
);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
}

interface FakeAcpScriptContext {
  workspaceDir: string;
  stderr: PassThrough;
  emitUpdate: (params: any) => void;
  sendResult: (id: number | string, result: unknown) => void;
  sendError: (id: number | string, code: number, message: string) => void;
  exitProcess: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

function createScriptedFakeAcpChild(
  workspaceDir: string,
  onPrompt: (ctx: FakeAcpScriptContext, turnIndex: number) => void | Promise<void>,
  onStartup?: (ctx: FakeAcpScriptContext) => void,
): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let promptTurn = 0;
  let startedNotified = false;

  const send = (payload: unknown) => {
    stdout.write(JSON.stringify(payload) + "\n");
  };

  let childRef: any;
  const ctx: FakeAcpScriptContext = {
    workspaceDir,
    stderr,
    emitUpdate: (params: any) => {
      send({ jsonrpc: "2.0", method: "session/update", params });
    },
    sendResult: (id: number | string, result: unknown) => {
      send({ jsonrpc: "2.0", id, result });
    },
    sendError: (id: number | string, code: number, message: string) => {
      send({ jsonrpc: "2.0", id, error: { code, message } });
    },
    exitProcess: (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (childRef) childRef.exitCode = code ?? 1;
      emitter.emit("exit", code, signal);
    },
  };

  let remainder = "";
  stdin.on("data", (chunk: Buffer | string) => {
    remainder += chunk.toString("utf-8");
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "initialize") {
        if (!startedNotified) {
          startedNotified = true;
          onStartup?.(ctx);
        }
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        });
      } else if (msg.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId: "native-diag-sess-1",
            configOptions: [
              {
                id: "model",
                category: "model",
                currentValue: "gemini-4-carbon",
                options: [{ value: "gemini-4-carbon" }, { value: "gemini-3.8-flash" }],
              },
            ],
          },
        });
      } else if (msg.method === "session/set_config_option" || msg.method === "session/set_model") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "session/prompt") {
        promptTurn += 1;
        void Promise.resolve(onPrompt(ctx, promptTurn));
      }
    }
  });

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    exitCode: 0,
    signalCode: null,
    killed: false,
    kill: () => {
      (child as any).killed = true;
      return true;
    },
  });
  childRef = child;

  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("TurnLogWatch", () => {
  test("captures current-turn bytes from pre-existing and new agy-acp.log.<pid> files while ignoring pre-mark 401/429", () => {
    const dir = makeTempDir("watch-basic-");
    const frontLog = path.join(dir, "agy-acp.log");
    const worker1Log = path.join(dir, "agy-acp.log.1321882");

    fs.writeFileSync(
      frontLog,
      "I1113 20:00:00.000001       1 front.go:368] front: initialize\n",
    );
    fs.writeFileSync(
      worker1Log,
      [
        "E1113 20:01:00.000001     100 server.go:1] old turn rpc error: code = ResourceExhausted desc = exhausted your quota",
        "E1113 20:01:05.000002     100 oauth.go:2] old turn invalid_grant authentication expired",
        "",
      ].join("\n"),
    );

    const watch = new TurnLogWatch(dir);
    watch.markTurnStart();

    fs.appendFileSync(
      frontLog,
      "I1113 20:12:05.388034       1 front.go:368] front: session/prompt\n",
    );
    fs.appendFileSync(
      worker1Log,
      "E1113 20:12:05.437065     391 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n",
    );
    const worker2Log = path.join(dir, "agy-acp.log.1329999");
    fs.writeFileSync(
      worker2Log,
      "E1113 20:12:06.100000     410 worker.go:88] new worker stream reset\n",
    );

    const evidence = watch.readTurnEvidence();
    expect(evidence).not.toContain("old turn rpc error");
    expect(evidence).not.toContain("old turn invalid_grant");
    expect(evidence).toContain("# agy-acp.log.1321882");
    expect(evidence).toContain("maxMessageTokens must be positive, got 0");
    expect(evidence).toContain("# agy-acp.log.1329999");
    expect(evidence).toContain("new worker stream reset");
    expect(classifyAgentFailure(evidence)).toBe("context_budget");
  });

  test("detects truncation and inode replacement even when replacement is larger than prior offset", () => {
    const dir = makeTempDir("watch-trunc-replace-");
    const truncLog = path.join(dir, "agy-acp.log.101");
    const replaceLog = path.join(dir, "agy-acp.log.202");

    fs.writeFileSync(
      truncLog,
      "E1113 20:00:00.000001 1 old.go:1] " + "X".repeat(1024) + "\n",
    );
    fs.writeFileSync(
      replaceLog,
      "E1113 20:00:00.000002 2 old.go:2] " + "Y".repeat(256) + "\n",
    );

    const watch = new TurnLogWatch(dir);
    watch.markTurnStart();

    // 1. Truncate in-place to a smaller error line
    fs.writeFileSync(
      truncLog,
      "E1113 20:10:00.000001 1 new.go:1] truncated turn failure\n",
    );

    // 2. Replace with a new inode whose size exceeds the previous mark.size
    const staged = path.join(dir, ".staged-replace");
    fs.writeFileSync(
      staged,
      "E1113 20:10:01.000002 2 new.go:2] replaced inode " + "Z".repeat(512) + "\n",
    );
    fs.renameSync(staged, replaceLog);

    const evidence = watch.readTurnEvidence();
    expect(evidence).toContain("truncated turn failure");
    expect(evidence).toContain("replaced inode");
    expect(evidence).not.toContain("XXXX");
    expect(evidence).not.toContain("YYYY");
  });

  test("enforces maxFiles, maxBytesPerFile, and maxTotalBytes bounds", () => {
    const dir = makeTempDir("watch-bounds-");
    const baseLog = path.join(dir, "agy-acp.log");
    fs.writeFileSync(baseLog, "I1113 20:00:00.000001 1 front.go:1] front start\n");

    const now = Date.now() / 1000;
    for (let i = 1; i <= 5; i += 1) {
      const f = path.join(dir, `agy-acp.log.${1000 + i}`);
      fs.writeFileSync(f, "");
      fs.utimesSync(f, now - (10 - i), now - (10 - i));
    }

    const watch = new TurnLogWatch(dir, {
      maxFiles: 3,
      maxBytesPerFile: 120,
      maxTotalBytes: 180,
    });
    watch.markTurnStart();

    // Write 400 bytes to newest worker log (.1005) and 200 bytes to .1004 and baseLog
    const log5 = path.join(dir, "agy-acp.log.1005");
    const log4 = path.join(dir, "agy-acp.log.1004");
    const log1 = path.join(dir, "agy-acp.log.1001");
    fs.writeFileSync(
      log5,
      "HEAD_5_" + "A".repeat(320) + "_TAIL_5_ERROR\n",
    );
    fs.utimesSync(log5, now + 5, now + 5);
    fs.writeFileSync(
      log4,
      "HEAD_4_" + "B".repeat(160) + "_TAIL_4_ERROR\n",
    );
    fs.utimesSync(log4, now + 4, now + 4);
    fs.appendFileSync(baseLog, "BASE_" + "C".repeat(90) + "_END\n");
    fs.writeFileSync(log1, "OLDEST_SHOULD_NOT_BE_READ\n");
    fs.utimesSync(log1, now - 100, now - 100);

    const evidence = watch.readTurnEvidence();
    // Only base + 2 newest worker logs (.1005, .1004) fit in maxFiles=3
    expect(evidence).not.toContain("OLDEST_SHOULD_NOT_BE_READ");
    expect(evidence).not.toContain("# agy-acp.log.1001");
    // Tail of log5 is kept within maxBytesPerFile=120; head was trimmed
    expect(evidence).toContain("_TAIL_5_ERROR");
    expect(evidence).not.toContain("HEAD_5_");
    // Total slice payload across files stays within maxTotalBytes=180
    const sectionPayloads = evidence
      .split(/^# [^\n]+\n/m)
      .slice(1)
      .map((s, idx, arr) => (idx < arr.length - 1 && s.endsWith("\n") ? s.slice(0, -1) : s));
    const totalPayloadBytes = sectionPayloads.reduce((sum, s) => sum + s.length, 0);
    expect(totalPayloadBytes).toBeLessThanOrEqual(180);
  });

  test("ignores unrelated files and non-file directories matching log pattern", () => {
    const dir = makeTempDir("watch-ignore-");
    fs.writeFileSync(path.join(dir, "agy-acp.log.bak"), "E1113 20:00:00.000001 1 a.go:1] RESOURCE_EXHAUSTED\n");
    fs.writeFileSync(path.join(dir, "agy-acp.log.txt"), "E1113 20:00:00.000001 1 a.go:1] invalid_grant\n");
    fs.writeFileSync(path.join(dir, "agy-acp.log.123.gz"), "E1113 20:00:00.000001 1 a.go:1] 429\n");
    fs.writeFileSync(path.join(dir, "agy-acp.log.abc"), "E1113 20:00:00.000001 1 a.go:1] 429\n");
    fs.writeFileSync(path.join(dir, "other.log"), "E1113 20:00:00.000001 1 a.go:1] RESOURCE_EXHAUSTED\n");
    fs.mkdirSync(path.join(dir, "agy-acp.log.999"));

    const watch = new TurnLogWatch(dir);
    expect(watch.readTurnEvidence()).toBe("");
  });
});

describe("extractErrorEvidence and classifyAgentFailure", () => {
  test("drops benign quotaProject= and 429 in glog timestamp/pid/line/localhost port", () => {
    const benignRaw = [
      "I1113 20:04:29.429000     429 server_oauth.go:429] applyAuthResult: email=u@example.com, authMethod=consumer, quotaProject=",
      "I1113 20:04:29.429111     429 http_helpers.go:429] connected to http://127.0.0.1:42912/mcp",
    ].join("\n");

    expect(extractErrorEvidence(benignRaw)).toBe("");
    // Desired contract: classifyAgentFailure on benign-only raw logs must NOT misclassify as quota.
    expect(classifyAgentFailure(benignRaw)).toBe("internal");
  });

  test("ignores startup 'not logged in' token-source noise as auth", () => {
    const startupNoise = [
      "E1113 20:30:50.719758      82 errorreport.go:273] error getting token source: You are not logged into Antigravity.",
      "E1113 20:30:50.720084      54 errorreport.go:273] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.",
      "W1113 20:12:02.728214     115 rpcs_plugin_auth.go:109] Not reloading plugin MCP servers: cannot get the signed-in user: error getting token source: You are not logged into Antigravity.",
      "I1113 20:12:02.700000      12 quota.go:50] doRefreshQuota: skipped (not logged in)",
    ].join("\n");

    // Startup chatter alone must NOT classify as auth!
    expect(classifyAgentFailure(startupNoise)).toBe("internal");

    const combinedWithRealInternal = [
      startupNoise,
      "E1113 20:30:55.100000     150 executor.go:99] agent executor error: unexpected EOF from backend",
    ].join("\n");
    expect(extractErrorEvidence(combinedWithRealInternal)).toContain(
      "agent executor error: unexpected EOF from backend",
    );
    expect(classifyAgentFailure(combinedWithRealInternal)).toBe("internal");
  });

  test("does not false-quota when an error shares a line with numeric IDs, ports, or durations", () => {
    const line =
      "E1113 20:04:29.429000     429 errorreport.go:429] agent executor error: upstream request 142900 to http://127.0.0.1:429/v1 and http://localhost:42912 failed after 429ms (pid 429, code 503)";
    const ev = extractErrorEvidence(line);
    expect(ev).toContain("upstream request 142900");
    expect(classifyAgentFailure(ev)).toBe("internal");
    expect(classifyAgentFailure(line)).toBe("internal");
  });

  test("classifies real RESOURCE_EXHAUSTED and HTTP 429 errors as quota", () => {
    const rpcQuota =
      "E1113 20:15:00.123456     500 errorreport.go:273] agent executor error: rpc error: code = ResourceExhausted desc = You have exhausted your quota for this model.";
    const http429 =
      "E1113 20:15:01.123456     500 http_helpers.go:100] HTTP 429 Too Many Requests";
    const warn429 =
      "W1113 20:15:02.123456     500 http_helpers.go:100] rate_limit_exceeded: RESOURCE_EXHAUSTED";

    expect(classifyAgentFailure(rpcQuota)).toBe("quota");
    expect(classifyAgentFailure(http429)).toBe("quota");
    expect(extractErrorEvidence(warn429)).toContain("RESOURCE_EXHAUSTED");
    expect(classifyAgentFailure(warn429)).toBe("quota");
  });

  test("classifies explicit raw RPC 401 / auth failures as auth", () => {
    const rpcUnauth =
      "E1113 20:15:00.123456     500 server.go:123] rpc error: code = Unauthenticated desc = please sign in";
    const invalidGrant =
      "E1113 20:15:01.123456     500 oauth.go:88] token refresh failed: invalid_grant";
    const rawRpc401 = "ACP prompt failed: HTTP 401 Unauthenticated (token expired)";

    expect(classifyAgentFailure(rpcUnauth)).toBe("auth");
    expect(classifyAgentFailure(invalidGrant)).toBe("auth");
    expect(classifyAgentFailure(rawRpc401)).toBe("auth");
  });

  test("classifies maxMessageTokens must be positive, got 0 as context_budget (not quota)", () => {
    const raw = [
      "I1113 20:12:02.737178      54 server_oauth.go:221] applyAuthResult: email=u@example.com, authMethod=consumer, quotaProject=",
      "E1113 20:12:05.437065     391 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0",
    ].join("\n");

    expect(classifyAgentFailure(raw)).toBe("context_budget");
  });

  test("classifies invalid request markers as invalid_request", () => {
    const raw =
      "E1113 20:15:00.123456     500 server.go:123] rpc error: code = InvalidArgument desc = bad request";
    expect(classifyAgentFailure(raw)).toBe("invalid_request");
  });

  test("regression #1: extract -> classify double filtering preserves HTTP 429, status: 429, and Please sign in", () => {
    const glog429 = "E1113 20:15:01.123456     500 http.go:100] HTTP 429";
    const glogStatus429 = "E1113 20:15:01.123456     500 http.go:101] status: 429";
    const glogSignIn = "E1113 20:15:01.123456     500 auth.go:102] Please sign in";

    expect(extractErrorEvidence(extractErrorEvidence(glog429))).toBe("HTTP 429");
    expect(extractErrorEvidence(extractErrorEvidence(glogStatus429))).toBe("status: 429");
    expect(extractErrorEvidence(extractErrorEvidence(glogSignIn))).toBe("Please sign in");

    expect(classifyAgentFailure(extractErrorEvidence(glog429))).toBe("quota");
    expect(classifyAgentFailure(extractErrorEvidence(glogStatus429))).toBe("quota");
    expect(classifyAgentFailure(extractErrorEvidence(glogSignIn))).toBe("auth");

    expect(classifyAgentFailure("HTTP 429")).toBe("quota");
    expect(classifyAgentFailure("status: 429")).toBe("quota");
    expect(classifyAgentFailure("Please sign in")).toBe("auth");
  });

  test("regression #5a: AcpConnection exit wrapper embedding old startup stderr tail does not trigger auth or quota", () => {
    const wrapperError = [
      "ACP request 'session/prompt' (id: 4) aborted: ACP process exited (code: 1, signal: null). Stderr tail:",
      "E1113 20:00:00.000001 1 auth.go:1] You are not logged into Antigravity.",
      "E1113 20:00:01.000001 1 quota.go:1] RESOURCE_EXHAUSTED",
    ].join("\n");

    expect(classifyAgentFailure("", wrapperError)).toBe("internal");
  });
});

describe("stderrDelta", () => {
  test("extracts appended delta and wrapped ring-buffer suffix while ignoring old 401/429", () => {
    const oldErr =
      "E1113 20:00:00.000001 1 old.go:1] RESOURCE_EXHAUSTED invalid_grant\n";
    expect(stderrDelta(oldErr, oldErr)).toBe("");

    const appended =
      oldErr + "E1113 20:10:00.000001 2 new.go:2] new failure\n";
    expect(stderrDelta(oldErr, appended)).toBe(
      "E1113 20:10:00.000001 2 new.go:2] new failure\n",
    );

    // Simulated 16 KiB ring buffer wrap where oldErr fell inside the baseline
    // and survived inside the wrapped overlap prefix
    const padA = "A".repeat(4000);
    const padB = "B".repeat(4000);
    const baseline = padA + oldErr + padB;
    const newTail = "E1113 20:11:00.000001 3 tail.go:3] maxMessageTokens must be positive, got 0\n";
    const wrapped = (baseline + newTail).slice(-baseline.length);

    const delta = stderrDelta(baseline, wrapped);
    expect(delta).toBe(newTail);
    expect(delta).not.toContain("RESOURCE_EXHAUSTED");
    expect(delta).not.toContain("invalid_grant");
  });
});

describe("AgySessionWorker diagnostics integration", () => {
  let mcpServer: LoopbackMcpServer;
  let origEnv: Record<string, string | undefined> = {};
  const account: AccountDescriptor = {
    slotKey: "agy-acp",
    accountRef: "11111111-1111-4111-8111-111111111111",
    mode: "host",
    label: "diag-test",
    isolatedHomeDir: null,
  };

  beforeAll(() => {
    origEnv = {
      ANTIGRAVITY_MAGPIE_DATA_DIR: process.env.ANTIGRAVITY_MAGPIE_DATA_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = path.join(TEMP_ROOT, "data");
    process.env.XDG_CONFIG_HOME = path.join(TEMP_ROOT, "config");
    process.env.XDG_CACHE_HOME = path.join(TEMP_ROOT, "cache");
    fs.mkdirSync(path.join(TEMP_ROOT, "data"), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, "config"), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, "cache"), { recursive: true });
    mcpServer = new LoopbackMcpServer();
    mcpServer.start();
  });

  afterAll(() => {
    mcpServer.stop();
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  async function runTurn(
    worker: AgySessionWorker,
    text: string,
  ): Promise<TurnStreamEvent[]> {
    const events: TurnStreamEvent[] = [];
    for await (const ev of worker.startPromptTurn([{ type: "text", text }])) {
      events.push(ev);
    }
    return events;
  }

  test("diagnoses maxMessageTokens=0 from numbered worker log despite startup auth/quota noise", async () => {
    const ws = makeTempDir("worker-ctx-budget-");
    const workerLog = path.join(ws, "agy-acp.log.1321882");
    const frontLog = path.join(ws, "agy-acp.log");

    const worker = new AgySessionWorker(account, "diag-sess-budget", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(
          ws,
          (ctx) => {
            fs.appendFileSync(
              frontLog,
              "I1113 20:12:05.388034       1 front.go:368] front: session/prompt\n",
            );
            fs.appendFileSync(
              workerLog,
              "E1113 20:12:05.437065     391 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n",
            );
            ctx.emitUpdate({
              sessionId: "native-diag-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "\n⚠ Agent execution terminated due to error.\n" },
              },
            });
            ctx.sendResult(3, { stopReason: "end_turn" });
          },
          (ctx) => {
            fs.writeFileSync(
              frontLog,
              "I1113 20:12:02.574099       1 options.go:463] Starting ACP front\n",
            );
            fs.writeFileSync(
              workerLog,
              [
                "E1113 20:12:02.710000      82 errorreport.go:273] error getting token source: You are not logged into Antigravity.",
                "I1113 20:12:02.737178      54 server_oauth.go:221] applyAuthResult: email=u@example.com, authMethod=consumer, quotaProject=",
                "",
              ].join("\n"),
            );
            ctx.stderr.write(
              "E1113 20:12:02.710000      82 errorreport.go:273] error getting token source: You are not logged into Antigravity.\n",
            );
          },
        ),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "hello");
      const errEv = events.find((e) => e.type === "error");
      expect(errEv).toEqual({
        type: "error",
        status: 500,
        errorType: "api_error",
        message: CONTEXT_BUDGET_FAILURE_MESSAGE,
      });
      expect(CONTEXT_BUDGET_FAILURE_MESSAGE).not.toMatch(/quota|rate.?limit/i);
    } finally {
      await worker.close("test_done");
    }
  });

  test("isolates turns on the same worker: Turn 1 429 does not poison Turn 2 internal 500", async () => {
    const ws = makeTempDir("worker-multi-turn-");
    const workerLog = path.join(ws, "agy-acp.log.55501");

    const worker = new AgySessionWorker(account, "diag-sess-multi", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx, turn) => {
          if (turn === 1) {
            fs.appendFileSync(
              workerLog,
              "E1113 20:05:08.100000     500 errorreport.go:273] rpc error: code = ResourceExhausted desc = exhausted your quota\n",
            );
            ctx.stderr.write(
              "E1113 20:05:08.100000     500 errorreport.go:273] RESOURCE_EXHAUSTED\n",
            );
            ctx.emitUpdate({
              sessionId: "native-diag-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "\n⚠ Agent execution terminated due to error.\n" },
              },
            });
            ctx.sendResult(3, { stopReason: "end_turn" });
          } else {
            fs.appendFileSync(
              workerLog,
              "E1113 20:05:14.429000     429 errorreport.go:429] upstream dial 127.0.0.1:42912 failed after 429ms\n",
            );
            ctx.emitUpdate({
              sessionId: "native-diag-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "\n⚠ Agent execution terminated due to error.\n" },
              },
            });
            ctx.sendResult(4, { stopReason: "end_turn" });
          }
        }),
    });

    try {
      await worker.start();
      const t1 = await runTurn(worker, "turn 1");
      expect(t1.find((e) => e.type === "error")).toEqual({
        type: "error",
        status: 429,
        errorType: "rate_limit_error",
        message: "Account quota exhausted",
      });

      const t2 = await runTurn(worker, "turn 2");
      const err2 = t2.find((e) => e.type === "error");
      expect(err2?.type === "error" && err2.status).toBe(500);
      expect(err2?.type === "error" && err2.errorType).toBe("api_error");
    } finally {
      await worker.close("test_done");
    }
  });

  test("diagnoses current-turn RPC Unauthenticated in a newly spawned numbered worker log as 401", async () => {
    const ws = makeTempDir("worker-auth-401-");

    const worker = new AgySessionWorker(account, "diag-sess-401", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          fs.writeFileSync(
            path.join(ws, "agy-acp.log.77777"),
            "E1113 20:16:00.000001     777 auth.go:44] rpc error: code = Unauthenticated desc = please sign in\n",
          );
          ctx.emitUpdate({
            sessionId: "native-diag-sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Agent execution terminated due to error.\n" },
            },
          });
          ctx.sendResult(3, { stopReason: "end_turn" });
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "auth check");
      expect(events.find((e) => e.type === "error")).toEqual({
        type: "error",
        status: 401,
        errorType: "authentication_error",
        message: "Antigravity CLI authentication expired. Please sign in again.",
        signInExpired: true,
      });
    } finally {
      await worker.close("test_done");
    }
  });

  test("regression #2: direct RPC auth errors ('You are not logged into Antigravity.' / 'not signed in') return 401 while ambient startup log noise stays 500", async () => {
    for (const rpcMsg of [
      "You are not logged into Antigravity.",
      "User is not signed in",
    ]) {
      const ws = makeTempDir("worker-rpc-auth-");
      const worker = new AgySessionWorker(account, `diag-rpc-${Date.now()}`, mcpServer, {
        workspaceDir: ws,
        spawnFn: () =>
          createScriptedFakeAcpChild(ws, (ctx) => {
            ctx.sendError(3, -32000, rpcMsg);
          }),
      });
      try {
        await worker.start();
        const res = await encodeAnthropicSseResponse(
          "gemini-4-carbon",
          worker.startPromptTurn([{ type: "text", text: "hi" }]),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get(SIGN_IN_HEADER)).toBe("expired");
        const body: any = await res.json();
        expect(body).toEqual({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Antigravity CLI authentication expired. Please sign in again.",
          },
        });
      } finally {
        await worker.close("test_done");
      }
    }

    // Contrast: ambient startup 'You are not logged into Antigravity.' in worker log + generic failure must remain 500
    const wsAmbient = makeTempDir("worker-ambient-auth-");
    const workerLog = path.join(wsAmbient, "agy-acp.log.88888");
    const workerAmbient = new AgySessionWorker(account, "diag-ambient-500", mcpServer, {
      workspaceDir: wsAmbient,
      spawnFn: () =>
        createScriptedFakeAcpChild(
          wsAmbient,
          (ctx) => {
            fs.appendFileSync(
              workerLog,
              "E1113 20:16:05.000001     888 errorreport.go:273] error getting token source: You are not logged into Antigravity.\n",
            );
            ctx.emitUpdate({
              sessionId: "native-diag-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "\n⚠ Agent execution terminated due to error.\n" },
              },
            });
            ctx.sendResult(3, { stopReason: "end_turn" });
          },
          (ctx) => {
            fs.writeFileSync(
              workerLog,
              "E1113 20:16:00.000001     888 errorreport.go:273] error getting token source: You are not logged into Antigravity.\n",
            );
            ctx.stderr.write(
              "E1113 20:16:00.000001     888 errorreport.go:273] You are not logged into Antigravity.\n",
            );
          },
        ),
    });
    try {
      await workerAmbient.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        workerAmbient.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
    } finally {
      await workerAmbient.close("test_done");
    }
  });

  test("regression #3 & #4: worker -> encodeAnthropicSseResponse emits HTTP 429/500/401 JSON + expired header and never leaks raw quotaProject metadata", async () => {
    // 1) HTTP 429 from numbered log before first content
    const ws429 = makeTempDir("worker-http-429-");
    const w429 = new AgySessionWorker(account, "diag-http-429", mcpServer, {
      workspaceDir: ws429,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws429, (ctx) => {
          fs.writeFileSync(
            path.join(ws429, "agy-acp.log.91001"),
            "E1113 20:17:00.000001     910 http.go:100] HTTP 429\n",
          );
          ctx.emitUpdate({
            sessionId: "native-diag-sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Agent execution terminated due to error.\n" },
            },
          });
          ctx.sendResult(3, { stopReason: "end_turn" });
        }),
    });
    try {
      await w429.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        w429.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(429);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
      expect(await res.json()).toEqual({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Account quota exhausted",
        },
      });
    } finally {
      await w429.close("test_done");
    }

    // 2) HTTP 401 with x-magpie-sign-in: expired before first content
    const ws401 = makeTempDir("worker-http-401-");
    const w401 = new AgySessionWorker(account, "diag-http-401", mcpServer, {
      workspaceDir: ws401,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws401, (ctx) => {
          fs.writeFileSync(
            path.join(ws401, "agy-acp.log.91002"),
            "E1113 20:17:01.000001     910 auth.go:100] Please sign in\n",
          );
          ctx.emitUpdate({
            sessionId: "native-diag-sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Agent execution terminated due to error.\n" },
            },
          });
          ctx.sendResult(3, { stopReason: "end_turn" });
        }),
    });
    try {
      await w401.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        w401.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get(SIGN_IN_HEADER)).toBe("expired");
      expect(await res.json()).toEqual({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Antigravity CLI authentication expired. Please sign in again.",
        },
      });
    } finally {
      await w401.close("test_done");
    }

    // 3) HTTP context_budget 500 from numbered worker log before first content
    const wsBudget = makeTempDir("worker-http-budget-500-");
    const wBudget = new AgySessionWorker(account, "diag-http-budget-500", mcpServer, {
      workspaceDir: wsBudget,
      spawnFn: () =>
        createScriptedFakeAcpChild(wsBudget, (ctx) => {
          fs.writeFileSync(
            path.join(wsBudget, "agy-acp.log.91004"),
            "E1113 20:17:01.500001     910 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n",
          );
          ctx.emitUpdate({
            sessionId: "native-diag-sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Agent execution terminated due to error.\n" },
            },
          });
          ctx.sendResult(3, { stopReason: "end_turn" });
        }),
    });
    try {
      await wBudget.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        wBudget.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
      const rawBudgetJson = await res.text();
      expect(rawBudgetJson).not.toMatch(/quota|rate.?limit/i);
      expect(JSON.parse(rawBudgetJson)).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message: CONTEXT_BUDGET_FAILURE_MESSAGE,
        },
      });
    } finally {
      await wBudget.close("test_done");
    }

    // 4) Public generic 500 never emits raw quotaProject metadata, private paths, or raw secrets
    const ws500 = makeTempDir("worker-http-500-");
    const w500 = new AgySessionWorker(account, "diag-http-500", mcpServer, {
      workspaceDir: ws500,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws500, (ctx) => {
          fs.writeFileSync(
            path.join(ws500, "agy-acp.log.91003"),
            [
              "I1113 20:17:02.000001     910 server_oauth.go:221] applyAuthResult: email=u@example.com, authMethod=consumer, quotaProject=internal-proj-secret",
              "E1113 20:17:02.000002     910 executor.go:99] agent executor error: unexpected failure at /Users/private/repo/secret.ts with token ya29.secret-token and quotaProject=internal-proj-secret",
              "",
            ].join("\n"),
          );
          ctx.sendError(
            3,
            -32000,
            "ACP process exited at /Users/private/repo/secret.ts: Bearer ya29.secret-token quotaProject=internal-proj-secret",
          );
        }),
    });
    try {
      await w500.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        w500.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
      const rawJson = await res.text();
      expect(rawJson).not.toContain("quotaProject");
      expect(rawJson).not.toContain("internal-proj-secret");
      expect(rawJson).not.toContain("/Users/private/");
      expect(rawJson).not.toContain("ya29.secret-token");
      expect(rawJson).not.toMatch(/quota/i);
      const parsed: any = JSON.parse(rawJson);
      expect(parsed).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message: GENERIC_FAILURE_MESSAGE,
        },
      });
    } finally {
      await w500.close("test_done");
    }
  });

  test("regression #5b: AcpConnection exit wrapper and process exit ignore embedded startup stderr tail (no 401/429, no expired header)", async () => {
    // 1) Prompt error carrying the AcpConnection exit wrapper + startup stderr tail -> HTTP 500 GENERIC_FAILURE_MESSAGE
    const wsWrapper = makeTempDir("worker-exit-wrapper-");
    const wWrapper = new AgySessionWorker(account, "diag-exit-wrapper", mcpServer, {
      workspaceDir: wsWrapper,
      spawnFn: () =>
        createScriptedFakeAcpChild(
          wsWrapper,
          (ctx) => {
            ctx.sendError(
              3,
              -32000,
              [
                "ACP request 'session/prompt' (id: 4) aborted: ACP process exited (code: 1, signal: null). Stderr tail:",
                "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.",
                "E1113 20:00:00.000002 1 startup.go:2] RESOURCE_EXHAUSTED quotaProject=internal-proj-secret",
              ].join("\n"),
            );
          },
          (ctx) => {
            ctx.stderr.write(
              [
                "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.",
                "E1113 20:00:00.000002 1 startup.go:2] RESOURCE_EXHAUSTED quotaProject=internal-proj-secret",
                "",
              ].join("\n"),
            );
          },
        ),
    });
    try {
      await wWrapper.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        wWrapper.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
      const rawJson = await res.text();
      expect(rawJson).not.toContain("quotaProject");
      expect(rawJson).not.toContain("internal-proj-secret");
      expect(JSON.parse(rawJson)).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message: GENERIC_FAILURE_MESSAGE,
        },
      });
    } finally {
      await wWrapper.close("test_done");
    }

    // 2) Actual process exit event during session/prompt -> HTTP 502 (not 401/429) and no expired header
    const wsExit = makeTempDir("worker-exit-event-");
    const wExit = new AgySessionWorker(account, "diag-exit-event", mcpServer, {
      workspaceDir: wsExit,
      spawnFn: () =>
        createScriptedFakeAcpChild(
          wsExit,
          (ctx) => {
            ctx.exitProcess(1, null);
          },
          (ctx) => {
            ctx.stderr.write(
              "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.\n",
            );
          },
        ),
    });
    try {
      await wExit.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        wExit.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(502);
      expect(res.headers.get(SIGN_IN_HEADER)).toBeNull();
      const body: any = await res.json();
      expect(body.type).toBe("error");
      expect(body.error?.type).toBe("api_error");
    } finally {
      await wExit.close("test_done");
    }
  });
});
