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
  CREDIT_EXHAUSTED_FAILURE_MESSAGE,
  MODEL_UNSERVED_FAILURE_MESSAGE,
  limitFreeDetail,
  retryAfterSecondsFrom,
  tooLongVetoed,
  upstreamDetail,
  withoutLocalPaths,
  TRANSIENT_LIMIT_FAILURE_MESSAGE,
  UPSTREAM_BUSY_FAILURE_MESSAGE,
  VENDOR_DISABLED_FAILURE_MESSAGE,
  VENDOR_POLICY_FAILURE_MESSAGE,
  TurnLogWatch,
  classifyAgentFailure,
  extractErrorEvidence,
  hasUpstreamRetryEvidence,
  looksLikeAgentRetryNotice,
  splitAgentRetryNotices,
  stderrDelta,
} from "../src/runtime/diagnostics";

const TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "agy-runtime-diagnostics-test-"),
);

/**
 * One turn's error event, asserted on the fixed sentence. The vendor's own words
 * may follow it ("Upstream said: …"), so the message is matched by prefix.
 */
function expectErrorEvent(
  events: TurnStreamEvent[],
  want: {
    status: number;
    errorType: Extract<TurnStreamEvent, { type: "error" }>["errorType"];
    message: string;
  },
): void {
  const ev = events.find((e) => e.type === "error") as
    | Extract<TurnStreamEvent, { type: "error" }>
    | undefined;
  expect(ev).toBeDefined();
  expect(ev!.status).toBe(want.status);
  expect(ev!.errorType).toBe(want.errorType);
  expect(ev!.message.startsWith(want.message)).toBe(true);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
}

/**
 * Stages the log line `agy` writes when it retries upstream. The plugin only
 * treats notice-shaped stream text as diagnostic when this evidence exists.
 */
function writeUpstreamRetryEvidence(workspaceDir: string): void {
  fs.writeFileSync(
    path.join(workspaceDir, "agy-acp.log.90001"),
    "I1114 16:08:30.490505     370 run.go:315] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).), retrying in 4s\n",
  );
}

interface FakeAcpScriptContext {
  workspaceDir: string;
  stderr: PassThrough;
  emitUpdate: (params: any) => void;
  sendResult: (id: number | string, result: unknown) => void;
  sendError: (id: number | string, code: number, message: string) => void;
  exitProcess: (code: number | null, signal?: NodeJS.Signals | null) => void;
  /**
   * Ends the current turn the way the real CLI does when the agent dies: the
   * terminal error chunk plus a plain `end_turn` result. Optionally stages a
   * numbered worker log line first, which is what the diagnosis reads.
   */
  terminateTurn: (log?: { name: string; text: string; append?: boolean }) => void;
  /** Answers the in-flight `session/prompt` with a JSON-RPC error. */
  failTurn: (message: string, code?: number) => void;
  /** Answers the in-flight `session/prompt` as cancelled, without logging. */
  cancelTurn: () => void;
  /** Answers the in-flight `session/prompt` with a plain `end_turn`. */
  finishTurn: () => void;
  /**
   * Answers the in-flight `session/prompt` as a refusal, optionally staging a
   * numbered worker log line first: `agy` says `stopReason: refusal` when the
   * agent stops for its own reason, and the log is what names it.
   */
  refuseTurn: (log?: { name: string; text: string; append?: boolean }) => void;
}

/** The chunk agy emits as the only content of a turn that failed internally. */
const AGENT_ERROR_CHUNK = "\n⚠ Agent execution terminated due to error.\n";

const NATIVE_SESSION_ID = "native-diag-sess-1";

/**
 * One worker→`encodeAnthropicSseResponse` case: every field is what a test would
 * otherwise assert by hand, so the scaffolding below is written exactly once.
 */
interface DiagnosedTurnCase {
  name: string;
  workspacePrefix: string;
  sessionId: string;
  /** What the scripted CLI does once `session/prompt` arrives. */
  script: (ctx: FakeAcpScriptContext) => void;
  /** Startup chatter written before the prompt arrives (if any). */
  startup?: (ctx: FakeAcpScriptContext) => void;
  status: number;
  signInHeader: string | null;
  /** Expected `Retry-After` header, when the refusal named a time. */
  retryAfter?: string;
  errorType: string;
  message?: string;
  /** Substrings that must never appear anywhere in the raw JSON body. */
  forbidden?: string[];
  /** Extra assertions over the raw (pre-parse) body. */
  checkRaw?: (raw: string) => void;
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
  // The id of the in-flight `session/prompt`, so a scripted turn can answer it
  // without every test hard-coding the JSON-RPC sequence.
  let promptRequestId: number | string = 3;
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
    terminateTurn: (log) => {
      if (log !== undefined) {
        const logPath = path.join(workspaceDir, log.name);
        if (log.append === true) fs.appendFileSync(logPath, log.text);
        else fs.writeFileSync(logPath, log.text);
      }
      ctx.emitUpdate({
        sessionId: NATIVE_SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: AGENT_ERROR_CHUNK },
        },
      });
      ctx.sendResult(promptRequestId, { stopReason: "end_turn" });
    },
    refuseTurn: (log) => {
      if (log !== undefined) {
        const logPath = path.join(workspaceDir, log.name);
        if (log.append === true) fs.appendFileSync(logPath, log.text);
        else fs.writeFileSync(logPath, log.text);
      }
      ctx.sendResult(promptRequestId, { stopReason: "refusal" });
    },
    failTurn: (message, code = -32000) => {
      ctx.sendError(promptRequestId, code, message);
    },
    cancelTurn: () => {
      ctx.sendResult(promptRequestId, { stopReason: "cancelled" });
    },
    finishTurn: () => {
      ctx.sendResult(promptRequestId, { stopReason: "end_turn" });
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
            sessionId: NATIVE_SESSION_ID,
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
        promptRequestId = msg.id;
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

  test("reads agy's own error codes and terminal wordings", () => {
    // The codes the vendor uses for model capacity, a ToS suspension and an
    // account that still needs verifying.
    expect(classifyAgentFailure("", "rpc error: code = ResourceExhausted desc = MODEL_CAPACITY_EXHAUSTED")).toBe(
      "rate_limit",
    );
    expect(classifyAgentFailure("", "PERMISSION_DENIED: TOS_VIOLATION")).toBe(
      "vendor_restricted",
    );
    expect(classifyAgentFailure("", "PERMISSION_DENIED: VALIDATION_REQUIRED")).toBe(
      "vendor_policy",
    );
    // agy 1.5.8's own terminal wordings.
    expect(
      classifyAgentFailure(
        "",
        "There was a network issue connecting to the server, please try again.",
      ),
    ).toBe("upstream_busy");
    expect(
      classifyAgentFailure("", "Your AI credits balance is too low to continue."),
    ).toBe("credit_exhausted");
  });

  test("appends the vendor's words without carrying limit wording into other verdicts", () => {
    // A detail is readable and bounded.
    expect(upstreamDetail("  a   b  ")).toBe("a b");
    expect(upstreamDetail("x".repeat(500)).length).toBe(400);
    // Google's boilerplate is dropped and a limit-sounding detail is refused, so
    // an echoed 400/403 can never read as a spent window to Magpie.
    expect(
      limitFreeDetail(
        "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).",
      ),
    ).toBe("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.");
    expect(limitFreeDetail("quota exceeded for model")).toBe("");
    expect(limitFreeDetail("invalid argument: image is too large")).toBe(
      "invalid argument: image is too large",
    );
  });

  test("drops a detail that would move the verdict, and keeps one that would not", () => {
    // Magpie's credit/limit vocabulary, not just the word "quota": `billing` alone
    // rests an account for half an hour as out of credit.
    expect(limitFreeDetail("PERMISSION_DENIED (code 403): Please enable billing")).toBe("");
    expect(limitFreeDetail("the caller has used up its budget for today")).toBe("");
    expect(limitFreeDetail("permission denied: region not allowed")).toBe(
      "permission denied: region not allowed",
    );
    // A token ceiling in the detail vetoes Magpie's overflow reading outright.
    expect(tooLongVetoed("max_output_tokens is 8192")).toBe(true);
    expect(tooLongVetoed("1000 tokens per minute")).toBe(true);
    expect(tooLongVetoed("maxMessageTokens must be positive, got 0")).toBe(false);
    // A local path names a filesystem the caller may not own.
    expect(withoutLocalPaths("failed at /Users/sid/repo/a.ts")).toBe(
      "failed at /Users/[user]/repo/a.ts",
    );
  });

  test("reads a Retry-After out of the refusal, clamped", () => {
    expect(retryAfterSecondsFrom("retrying in 4s")).toBe(4);
    expect(retryAfterSecondsFrom("please try again in 30 seconds")).toBe(30);
    expect(retryAfterSecondsFrom("quota resets in 2h")).toBe(7200);
    expect(retryAfterSecondsFrom("reset after 90 minutes")).toBe(5400);
    expect(retryAfterSecondsFrom("no time here")).toBeUndefined();
    // A turn that retried twice named two waits: the client must wait out the last.
    expect(
      retryAfterSecondsFrom(
        "Run: attempt 1 failed, retrying in 4s\nRun: attempt 2 failed, retrying in 32s",
      ),
    ).toBe(32);
    // A misread reset can't bench a client for longer than a day.
    expect(retryAfterSecondsFrom("resets in 99h")).toBe(86400);
  });

  test("recognizes upstream retry evidence in raw logs, including info records", () => {
    expect(
      hasUpstreamRetryEvidence(
        "I1114 16:08:30.490505     370 run.go:315] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429)), retrying in 4s",
      ),
    ).toBe(true);
    // A bare failure is not evidence that `agy` retried upstream.
    expect(hasUpstreamRetryEvidence("E1113 20:17:00.000001 910 http.go:100] HTTP 429")).toBe(
      false,
    );
    expect(hasUpstreamRetryEvidence("")).toBe(false);
  });

  test("separates agy retry notices from streamed text and holds a split prefix", () => {
    const notice =
      "\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n\n";
    const onlyNotice = splitAgentRetryNotices(notice);
    expect(onlyNotice.count).toBe(1);
    expect(onlyNotice.text.trim()).toBe("");
    expect(onlyNotice.hold).toBe("");

    const mixed = splitAgentRetryNotices(
      "before\n⚠ API error (attempt 2): boom\nafter",
    );
    expect(mixed.count).toBe(1);
    expect(mixed.text).toBe("before\nafter");
    expect(mixed.hold).toBe("");

    // A notice that starts in the last bytes of a chunk is held for the next one,
    // with the newline that separated it so the original bytes can be restored.
    const split = splitAgentRetryNotices("text\n⚠ API error (att");
    expect(split.count).toBe(0);
    expect(split.text).toBe("text");
    expect(split.hold).toBe("\n⚠ API error (att");

    // A header whose body is still to come is not a complete notice: consuming
    // it here would let the body arrive as model text.
    const headerOnly = splitAgentRetryNotices("\n⚠ API error (attempt 1):");
    expect(headerOnly.count).toBe(0);
    expect(headerOnly.text).toBe("");
    expect(headerOnly.hold).toBe("\n⚠ API error (attempt 1):");

    // …and it is counted exactly once when its newline arrives.
    const completed = splitAgentRetryNotices(
      headerOnly.hold + " RESOURCE_EXHAUSTED (code 429).\n",
    );
    expect(completed.count).toBe(1);
    expect(completed.text).toBe("");
    expect(completed.hold).toBe("");

    // A complete notice followed by the next one's header counts only the first.
    const pair = splitAgentRetryNotices(
      "⚠ API error (attempt 1): boom\n⚠ API error (attempt 2): ",
    );
    expect(pair.count).toBe(1);
    expect(pair.hold).toBe("\n⚠ API error (attempt 2): ");
    expect(looksLikeAgentRetryNotice(pair.hold)).toBe(true);
    expect(looksLikeAgentRetryNotice("API docs are in README")).toBe(false);

    // Releasing a held candidate reproduces the original bytes, newline included.
    const held = splitAgentRetryNotices("hello\nAPI");
    expect(held.text).toBe("hello");
    expect(held.hold).toBe("\nAPI");
    const released = splitAgentRetryNotices(held.hold + " documentation");
    expect(released.hold).toBe("");
    expect(released.text).toBe("\nAPI documentation");
  });

  test("holds only a fragment that could begin a notice, never ordinary answer text", () => {
    // A fragment that is a prefix of the notice start is held for the next chunk.
    expect(splitAgentRetryNotices("API").hold).toBe("API");
    // A fragment that already holds a notice start but has no newline yet is
    // held too: the attempt number or body is still to come.
    expect(splitAgentRetryNotices("\n⚠ API error (attempt ").hold).toBe(
      "\n⚠ API error (attempt ",
    );
    // The caller flushes a held fragment when the turn ends, so an answer that
    // merely begins like a notice is still delivered.
    expect(splitAgentRetryNotices("the answer is Option A").hold).toBe("");
    expect(splitAgentRetryNotices("API docs are in README").hold).toBe("");
  });

  test("classifies a named exhausted quota as quota and a bare 429 as rate_limit", () => {
    const rpcQuota =
      "E1113 20:15:00.123456     500 errorreport.go:273] agent executor error: rpc error: code = ResourceExhausted desc = You have exhausted your quota for this model.";
    const http429 =
      "E1113 20:15:01.123456     500 http_helpers.go:100] HTTP 429 Too Many Requests";
    const warn429 =
      "W1113 20:15:02.123456     500 http_helpers.go:100] rate_limit_exceeded: RESOURCE_EXHAUSTED";
    // The exact per-minute limit line `agy` writes while it backs off.
    const agyGeneric429 =
      "⚠ API error (attempt 8): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).";
    // Code Assist's own wording for a spent window names a reset, so it is quota.
    const capacityReset =
      "You have exhausted your capacity on this model. Your quota will reset after 2h.";

    expect(classifyAgentFailure(rpcQuota)).toBe("quota");
    expect(classifyAgentFailure(capacityReset)).toBe("quota");
    expect(classifyAgentFailure(http429)).toBe("rate_limit");
    expect(extractErrorEvidence(warn429)).toContain("RESOURCE_EXHAUSTED");
    expect(classifyAgentFailure(warn429)).toBe("rate_limit");
    expect(classifyAgentFailure(agyGeneric429)).toBe("rate_limit");
    // `agy` writes its in-process retry at info severity; that record is the
    // only evidence a single-retry 429 termination carries.
    expect(
      classifyAgentFailure(
        "I1114 16:08:30.490505     370 run.go:315] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).), retrying in 4s",
      ),
    ).toBe("rate_limit");
  });

  test("classifies the vendor disabling the account as vendor_restricted, not auth or quota", () => {
    const disabled =
      'error: This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product. AGY_ERROR: {"short_error":"PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service."}';
    expect(classifyAgentFailure("", disabled)).toBe("vendor_restricted");
    expect(
      classifyAgentFailure(
        `E1114 18:02:11.123456     400 errorreport.go:273] agent executor error: ${disabled}`,
      ),
    ).toBe("vendor_restricted");
    // A prompt-level refusal in different words is not the account's problem.
    expect(classifyAgentFailure("", "Request blocked by policy")).toBe("internal");
  });

  test("separates a policy 403, a model this account is not served, and the vendor's own busy", () => {
    // Permission denied without the suspension's words: the account, not the prompt.
    expect(
      classifyAgentFailure("", "PERMISSION_DENIED (code 403): The caller does not have permission"),
    ).toBe("vendor_policy");
    // Code Assist's NOT_FOUND for a model this account may not use.
    expect(
      classifyAgentFailure("", "NOT_FOUND (code 404): Requested entity was not found."),
    ).toBe("model_unserved");
    expect(
      classifyAgentFailure("", "FAILED_PRECONDITION (code 400): model gemini-4-carbon is not available to this project"),
    ).toBe("model_unserved");
    // agy's gRPC statuses for the vendor's own servers.
    for (const line of [
      "UNAVAILABLE (code 503): The service is currently unavailable.",
      "DEADLINE_EXCEEDED (code 504): Deadline expired before operation could complete.",
      "E1114 18:02:11.000001 400 upstream.go:9] 503 The model is overloaded",
    ]) {
      expect(classifyAgentFailure(line)).toBe("upstream_busy");
    }
    // A malformed request is still the request's, not the account's.
    expect(
      classifyAgentFailure("", "INVALID_ARGUMENT (code 400): Request contains an invalid argument."),
    ).toBe("invalid_request");
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

  test("classifies no-messages-fit trajectory refusals as context_budget", () => {
    const fromLog =
      "E1113 22:38:30.717067     318 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: no messages fit within the context token budget";
    const fromRpc =
      "serializing trajectory: no messages fit within the context token budget";

    expect(classifyAgentFailure(fromLog)).toBe("context_budget");
    expect(classifyAgentFailure(fromRpc)).toBe("context_budget");
    expect(classifyAgentFailure(extractErrorEvidence(fromLog))).toBe(
      "context_budget",
    );
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

    expect(classifyAgentFailure(extractErrorEvidence(glog429))).toBe("rate_limit");
    expect(classifyAgentFailure(extractErrorEvidence(glogStatus429))).toBe("rate_limit");
    expect(classifyAgentFailure(extractErrorEvidence(glogSignIn))).toBe("auth");

    expect(classifyAgentFailure("HTTP 429")).toBe("rate_limit");
    expect(classifyAgentFailure("status: 429")).toBe("rate_limit");
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
            ctx.terminateTurn();
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
      expectErrorEvent(events, {
        status: 400,
        errorType: "invalid_request_error",
        message: CONTEXT_BUDGET_FAILURE_MESSAGE,
      });
      expect(CONTEXT_BUDGET_FAILURE_MESSAGE).not.toMatch(/quota|rate.?limit/i);
      // Magpie reads a 400 as an overflow only when its words match tooLongRe
      // ("prompt is too long", "maximum context length", "reduce the length of
      // the messages"): it then asks a member with room and tells the agent to
      // compact.
      expect(CONTEXT_BUDGET_FAILURE_MESSAGE).toMatch(/prompt is too long/i);
      expect(CONTEXT_BUDGET_FAILURE_MESSAGE).toMatch(/maximum context length/i);
      expect(CONTEXT_BUDGET_FAILURE_MESSAGE).toMatch(/reduce the length of the messages/i);
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
            ctx.terminateTurn();
          } else {
            fs.appendFileSync(
              workerLog,
              "E1113 20:05:14.429000     429 errorreport.go:429] upstream dial 127.0.0.1:42912 failed after 429ms\n",
            );
            ctx.terminateTurn();
          }
        }),
    });

    try {
      await worker.start();
      const t1 = await runTurn(worker, "turn 1");
      expectErrorEvent(t1, {
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

  test("ends a turn that only spins through agy retry notices, without leaking them as text", async () => {
    const ws = makeTempDir("worker-retry-storm-");
    const worker = new AgySessionWorker(account, "diag-sess-storm", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          // `agy` streams its own retry notices while it backs off; nothing else
          // is produced, so the turn must not wait out the whole ladder.
          writeUpstreamRetryEvidence(ws);
          for (const attempt of [1, 2, 3]) {
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  text: `\n⚠ API error (attempt ${attempt}): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n\n`,
                },
              },
            });
          }
          setTimeout(() => ctx.cancelTurn(), 25);
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "storm");
      const leaked = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(leaked).toBe("");
      expectErrorEvent(events, { status: 429, errorType: "rate_limit_error", message: TRANSIENT_LIMIT_FAILURE_MESSAGE });
      // Magpie reads error text for quota wording and holds the account on a
      // match, so this message must stay outside both word families.
      expect(TRANSIENT_LIMIT_FAILURE_MESSAGE).not.toMatch(/quota|rate.?limit/i);
    } finally {
      await worker.close("test_done");
    }
  });

  test("delivers an answer whose last chunk looks like the start of a retry notice", async () => {
    const ws = makeTempDir("worker-notice-tail-");
    const worker = new AgySessionWorker(account, "diag-sess-tail", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          // `agy` notices begin with `API error (attempt`; a real answer can end
          // with the same first characters (` A` after `Option`). It must be
          // delivered, not held as a notice fragment and dropped.
          writeUpstreamRetryEvidence(ws);
          for (const chunk of ["The answer is Option", " A"]) {
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: chunk },
              },
            });
          }
          ctx.finishTurn();
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "tail");
      const answer = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(answer).toBe("The answer is Option A");
      expect(events.find((e) => e.type === "error")).toBeUndefined();
    } finally {
      await worker.close("test_done");
    }
  });

  test("delivers a quoted retry notice when the turn's log shows no upstream retry", async () => {
    const ws = makeTempDir("worker-notice-quoted-");
    const quoted =
      "⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n" +
      "⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n" +
      "That is what your log showed.";
    const worker = new AgySessionWorker(account, "diag-sess-quoted", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          // No `Run: attempt N failed` line: the model is quoting the incident,
          // not `agy` retrying, so every line belongs to the answer.
          ctx.emitUpdate({
            sessionId: NATIVE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: quoted },
            },
          });
          ctx.finishTurn();
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "explain the incident");
      const answer = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(answer).toBe(quoted);
      expect(events.find((e) => e.type === "error")).toBeUndefined();
    } finally {
      await worker.close("test_done");
    }
  });

  test("a notice the model quotes as answer text is not taken for the turn's failure", async () => {
    // A caller can ask what an error means, and the model then writes the notice
    // itself. Treating those words as the turn's failure would answer 402 and rest
    // a healthy account on its credit ladder.
    const ws = makeTempDir("worker-quoted-notice-");
    const worker = new AgySessionWorker(account, "diag-sess-quoted", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          ctx.emitUpdate({
            sessionId: NATIVE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "The bridge answers 402 when it reads:" },
            },
          });
          ctx.emitUpdate({
            sessionId: NATIVE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Your AI credits balance is too low to continue.\n" },
            },
          });
          ctx.finishTurn();
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "what does this error mean?");
      expect(events.some((e) => e.type === "error")).toBe(false);
      const text = events
        .filter((e): e is Extract<TurnStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.text)
        .join("");
      expect(text).toContain("The bridge answers 402");
      expect(text).toContain("credits balance is too low");
    } finally {
      await worker.close("test_done");
    }
  });

  test("a retry note split across two chunks is still stripped", async () => {
    const ws = makeTempDir("worker-split-note-");
    const worker = new AgySessionWorker(account, "diag-sess-split-note", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          ctx.emitUpdate({
            sessionId: NATIVE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "\n⚠ Model produced invalid" },
            },
          });
          ctx.emitUpdate({
            sessionId: NATIVE_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: " output.\n\nThe answer." },
            },
          });
          ctx.finishTurn();
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "split note");
      const text = events
        .filter((e): e is Extract<TurnStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.text)
        .join("");
      expect(text).not.toContain("Model produced invalid");
      expect(text).toContain("The answer.");
    } finally {
      await worker.close("test_done");
    }
  });

  test("answers a single-retry termination with the transient 429, not a generic 500", async () => {
    const ws = makeTempDir("worker-single-retry-log-");
    const worker = new AgySessionWorker(account, "diag-sess-single", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          // `agy` retried once (info severity), then gave up with the terminal
          // error marker. That record is the only evidence this turn has, so the
          // answer must be the transient 429 a caller can fail over on.
          ctx.terminateTurn({
            name: "agy-acp.log.91010",
            text: "I1114 16:08:30.490505     370 run.go:315] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).), retrying in 4s\n",
          });
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "single retry");
      expectErrorEvent(events, { status: 429, errorType: "rate_limit_error", message: TRANSIENT_LIMIT_FAILURE_MESSAGE });
    } finally {
      await worker.close("test_done");
    }
  });

  test("keeps the transient 429 when agy settles the cancelled prompt as an error", async () => {
    const ws = makeTempDir("worker-notice-cancel-error-");
    const worker = new AgySessionWorker(account, "diag-sess-cancel", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          writeUpstreamRetryEvidence(ws);
          for (const attempt of [1, 2]) {
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  text: `\n⚠ API error (attempt ${attempt}): RESOURCE_EXHAUSTED (code 429).\n`,
                },
              },
            });
          }
          // `agy` keeps streaming while the cancel travels, then settles the
          // prompt as an error. Neither may turn this turn into a generic 500 or
          // leak a chunk ahead of the 429.
          setTimeout(() => {
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "Recovered answer" },
              },
            });
          }, 10);
          setTimeout(() => ctx.failTurn("context canceled", -32800), 25);
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "cancel error");
      const leaked = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(leaked).toBe("");
      expectErrorEvent(events, { status: 429, errorType: "rate_limit_error", message: TRANSIENT_LIMIT_FAILURE_MESSAGE });
    } finally {
      await worker.close("test_done");
    }
  });

  test("strips a retry notice split across two chunks once the log corroborates it", async () => {
    const ws = makeTempDir("worker-notice-split-");
    const worker = new AgySessionWorker(account, "diag-sess-split", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          writeUpstreamRetryEvidence(ws);
          for (const chunk of [
            "\n⚠ API error (attempt ",
            "1): RESOURCE_EXHAUSTED (code 429).\n",
            "\n⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429).\n",
          ]) {
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: chunk },
              },
            });
          }
          setTimeout(() => ctx.cancelTurn(), 25);
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "split");
      const leaked = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(leaked).toBe("");
      expectErrorEvent(events, { status: 429, errorType: "rate_limit_error", message: TRANSIENT_LIMIT_FAILURE_MESSAGE });
    } finally {
      await worker.close("test_done");
    }
  });

  test("still guards a retry storm when the log record lands one chunk late", async () => {
    const ws = makeTempDir("worker-notice-late-log-");
    const worker = new AgySessionWorker(account, "diag-sess-late", mcpServer, {
      workspaceDir: ws,
      spawnFn: () =>
        createScriptedFakeAcpChild(ws, (ctx) => {
          const emit = (text: string) =>
            ctx.emitUpdate({
              sessionId: NATIVE_SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text },
              },
            });

          // The first notice arrives before `agy` has flushed its log line, and the
          // record stays unreadable through the second chunk (a split notice). It
          // must be held, not delivered as answer text: delivering it would mark
          // the turn as having produced work and blind the guard for good.
          emit("\n⚠ API error (attempt ");
          emit("1): RESOURCE_EXHAUSTED (code 429).\n");
          writeUpstreamRetryEvidence(ws);
          emit("\n⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429).\n");
          setTimeout(() => ctx.cancelTurn(), 25);
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "late log");
      const leaked = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<TurnStreamEvent, { type: "text_delta" }>).text)
        .join("");
      expect(leaked).toBe("");
      expectErrorEvent(events, { status: 429, errorType: "rate_limit_error", message: TRANSIENT_LIMIT_FAILURE_MESSAGE });
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
          ctx.terminateTurn({
            name: "agy-acp.log.77777",
            text: "E1113 20:16:00.000001     777 auth.go:44] rpc error: code = Unauthenticated desc = please sign in\n",
          });
        }),
    });

    try {
      await worker.start();
      const events = await runTurn(worker, "auth check");
      const authEv = events.find((e) => e.type === "error");
      expectErrorEvent(events, {
        status: 401,
        errorType: "authentication_error",
        message: "Antigravity CLI authentication expired. Please sign in again.",
      });
      expect((authEv as Extract<TurnStreamEvent, { type: "error" }>).signInExpired).toBe(true);
    } finally {
      await worker.close("test_done");
    }
  });
  const AUTH_EXPIRED_MESSAGE =
    "Antigravity CLI authentication expired. Please sign in again.";
  const QUOTA_EXHAUSTED_MESSAGE = "Account quota exhausted";

  /**
   * Every worker→HTTP case runs the same pipeline: start the worker, hand its
   * turn stream to `encodeAnthropicSseResponse`, then assert the response shape.
   * Only the scripted failure and the expected status/header/body differ, so
   * they live in this table instead of being copy-pasted per scenario.
   */
  const DIAGNOSED_TURN_CASES: DiagnosedTurnCase[] = [
    // regression #2: a direct RPC auth failure is a 401, never a generic 500.
    ...["You are not logged into Antigravity.", "User is not signed in"].map(
      (rpcMessage, index): DiagnosedTurnCase => ({
        name: `regression #2: direct RPC auth error ${JSON.stringify(rpcMessage)} returns 401 with the expired header`,
        workspacePrefix: "worker-rpc-auth-",
        sessionId: `diag-rpc-auth-${index}`,
        script: (ctx) => {
          ctx.failTurn(rpcMessage);
        },
        status: 401,
        signInHeader: "expired",
        errorType: "authentication_error",
        message: AUTH_EXPIRED_MESSAGE,
      }),
    ),

    // regression #2 contrast: the same phrasing as ambient startup chatter is not auth.
    {
      name: "regression #2: ambient 'not logged in' startup noise in worker log and stderr stays 500",
      workspacePrefix: "worker-ambient-auth-",
      sessionId: "diag-ambient-500",
      startup: (ctx) => {
        fs.writeFileSync(
          path.join(ctx.workspaceDir, "agy-acp.log.88888"),
          "E1113 20:16:00.000001     888 errorreport.go:273] error getting token source: You are not logged into Antigravity.\n",
        );
        ctx.stderr.write(
          "E1113 20:16:00.000001     888 errorreport.go:273] You are not logged into Antigravity.\n",
        );
      },
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.88888",
          append: true,
          text: "E1113 20:16:05.000001     888 errorreport.go:273] error getting token source: You are not logged into Antigravity.\n",
        });
      },
      status: 500,
      signInHeader: null,
      errorType: "api_error",
      message: GENERIC_FAILURE_MESSAGE,
    },

    // regression #3: a numbered worker log written during the turn, before content.
    {
      name: "regression #3: a bare numbered worker log HTTP 429 returns the transient 429 JSON",
      workspacePrefix: "worker-http-429-",
      sessionId: "diag-http-429",
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.91001",
          text: "E1113 20:17:00.000001     910 http.go:100] HTTP 429\n",
        });
      },
      status: 429,
      signInHeader: null,
      errorType: "rate_limit_error",
      message: TRANSIENT_LIMIT_FAILURE_MESSAGE,
    },
    {
      name: "agy's network-issue terminal marker answers 503 overloaded, not text",
      workspacePrefix: "worker-net-marker-",
      sessionId: "diag-net-marker",
      script: (ctx) => {
        ctx.emitUpdate({
          sessionId: NATIVE_SESSION_ID,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              text: "\n⚠ There was a network issue connecting to the server, please try again.\n",
            },
          },
        });
        ctx.finishTurn();
      },
      status: 503,
      signInHeader: null,
      errorType: "api_error",
      message: UPSTREAM_BUSY_FAILURE_MESSAGE,
    },
    {
      name: "agy's spent-credit terminal marker answers 402, not text",
      workspacePrefix: "worker-credit-marker-",
      sessionId: "diag-credit-marker",
      script: (ctx) => {
        ctx.emitUpdate({
          sessionId: NATIVE_SESSION_ID,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "\n⚠ Your AI credits balance is too low to continue.\n" },
          },
        });
        ctx.finishTurn();
      },
      status: 402,
      signInHeader: null,
      errorType: "api_error",
      message: CREDIT_EXHAUSTED_FAILURE_MESSAGE,
    },
    {
      name: "a refusal that names a wait answers with Retry-After",
      workspacePrefix: "worker-retry-after-",
      sessionId: "diag-retry-after",
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.91011",
          text: "E1114 18:02:11.000001 400 run.go:315] Run: attempt 1 failed (UNAVAILABLE (code 503): The service is currently unavailable), retrying in 7s\n",
        });
      },
      status: 503,
      signInHeader: null,
      retryAfter: "7",
      errorType: "api_error",
      message: UPSTREAM_BUSY_FAILURE_MESSAGE,
    },
    {
      name: "an echoed detail never carries a secret or a home path",
      workspacePrefix: "worker-busy-detail-",
      sessionId: "diag-busy-detail",
      script: (ctx) => {
        fs.writeFileSync(
          path.join(ctx.workspaceDir, "agy-acp.log.91021"),
          "E1114 18:31:00.000001 400 run.go:315] UNAVAILABLE (code 503): the model pool is full; Authorization: Bearer ya29.secret-token; see /Users/private/repo/secret.ts\n",
        );
        ctx.failTurn("ACP process exited");
      },
      status: 503,
      signInHeader: null,
      errorType: "api_error",
      message: UPSTREAM_BUSY_FAILURE_MESSAGE,
      forbidden: ["ya29.secret-token", "/Users/private/"],
      checkRaw: (raw) => {
        expect(raw).toContain("the model pool is full");
        expect(raw).toContain("/Users/[user]/repo/secret.ts");
      },
    },
    {
      name: "a 403 whose vendor text names billing stays a permission error",
      workspacePrefix: "worker-policy-billing-",
      sessionId: "diag-policy-billing",
      script: (ctx) => {
        fs.writeFileSync(
          path.join(ctx.workspaceDir, "agy-acp.log.91022"),
          "E1114 18:31:00.000002 400 run.go:315] PERMISSION_DENIED (code 403): please enable billing for this project\n",
        );
        ctx.failTurn("ACP process exited");
      },
      status: 403,
      signInHeader: null,
      errorType: "permission_error",
      message: VENDOR_POLICY_FAILURE_MESSAGE,
      forbidden: ["billing"],
    },
    {
      name: "a refusal completion keeps the diagnosis it names",
      workspacePrefix: "worker-refusal-403-",
      sessionId: "diag-refusal-403",
      script: (ctx) => {
        ctx.refuseTurn({
          name: "agy-acp.log.91023",
          text: "E1114 18:31:00.000003 400 run.go:315] PERMISSION_DENIED: this service has been disabled in this account for violation of Terms of Service\n",
        });
      },
      status: 403,
      signInHeader: null,
      errorType: "permission_error",
      message: VENDOR_DISABLED_FAILURE_MESSAGE,
    },
    {
      name: "a model this account is not served answers 404 so only that model rests",
      workspacePrefix: "worker-unserved-404-",
      sessionId: "diag-unserved-404",
      script: (ctx) => {
        ctx.failTurn("NOT_FOUND (code 404): Requested entity was not found.");
      },
      status: 404,
      signInHeader: null,
      errorType: "not_found_error",
      message: MODEL_UNSERVED_FAILURE_MESSAGE,
      forbidden: ["quota", "rate limit"],
    },
    {
      name: "the vendor's own UNAVAILABLE answers 503 overloaded so no failure is counted",
      workspacePrefix: "worker-busy-503-",
      sessionId: "diag-busy-503",
      script: (ctx) => {
        ctx.failTurn("UNAVAILABLE (code 503): The service is currently unavailable.");
      },
      status: 503,
      signInHeader: null,
      errorType: "api_error",
      message: UPSTREAM_BUSY_FAILURE_MESSAGE,
      forbidden: ["quota", "insufficient"],
      checkRaw: (raw) => {
        // Magpie reads a 5xx saying "overloaded" as the vendor being busy.
        expect(raw.toLowerCase()).toContain("overloaded");
      },
    },
    {
      name: "a policy 403 answers permission_error with the policy text",
      workspacePrefix: "worker-policy-403-",
      sessionId: "diag-policy-403",
      script: (ctx) => {
        ctx.failTurn("PERMISSION_DENIED (code 403): The caller does not have permission");
      },
      status: 403,
      signInHeader: null,
      errorType: "permission_error",
      message: VENDOR_POLICY_FAILURE_MESSAGE,
      forbidden: ["Terms of Service"],
    },
    {
      name: "a disabled account answers 403 with the vendor-disabled text",
      workspacePrefix: "worker-disabled-403-",
      sessionId: "diag-disabled-403",
      script: (ctx) => {
        ctx.failTurn(
          'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product. AGY_ERROR: {"short_error":"PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service."}',
        );
      },
      status: 403,
      signInHeader: null,
      errorType: "permission_error",
      message: VENDOR_DISABLED_FAILURE_MESSAGE,
      forbidden: ["quota", "rate limit"],
    },
    {
      name: "regression #3: a numbered worker log naming an exhausted quota returns the account-quota 429 JSON",
      workspacePrefix: "worker-http-quota-429-",
      sessionId: "diag-http-quota-429",
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.91005",
          text: "E1113 20:17:00.500001     910 errorreport.go:273] rpc error: code = ResourceExhausted desc = You have exhausted your quota for this model.\n",
        });
      },
      status: 429,
      signInHeader: null,
      errorType: "rate_limit_error",
      message: QUOTA_EXHAUSTED_MESSAGE,
    },
    {
      name: "regression #3: numbered worker log 'Please sign in' before first content returns 401 with the expired header",
      workspacePrefix: "worker-http-401-",
      sessionId: "diag-http-401",
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.91002",
          text: "E1113 20:17:01.000001     910 auth.go:100] Please sign in\n",
        });
      },
      status: 401,
      signInHeader: "expired",
      errorType: "authentication_error",
      message: AUTH_EXPIRED_MESSAGE,
    },
    {
      name: "regression #3: numbered worker log maxMessageTokens=0 returns the too-long 400",
      workspacePrefix: "worker-http-budget-500-",
      sessionId: "diag-http-budget-500",
      script: (ctx) => {
        ctx.terminateTurn({
          name: "agy-acp.log.91004",
          text: "E1113 20:17:01.500001     910 errorreport.go:273] agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n",
        });
      },
      status: 400,
      signInHeader: null,
      errorType: "invalid_request_error",
      message: CONTEXT_BUDGET_FAILURE_MESSAGE,
      checkRaw: (raw) => {
        expect(raw).not.toMatch(/quota|rate.?limit/i);
        expect(raw).toMatch(/prompt is too long/i);
      },
    },

    // regression #4: the public 500 must never echo private paths or credentials.
    {
      name: "regression #4: generic 500 never leaks quotaProject metadata, private paths, or raw secrets",
      workspacePrefix: "worker-http-500-",
      sessionId: "diag-http-500",
      script: (ctx) => {
        fs.writeFileSync(
          path.join(ctx.workspaceDir, "agy-acp.log.91003"),
          [
            "I1113 20:17:02.000001     910 server_oauth.go:221] applyAuthResult: email=u@example.com, authMethod=consumer, quotaProject=internal-proj-secret",
            "E1113 20:17:02.000002     910 executor.go:99] agent executor error: unexpected failure at /Users/private/repo/secret.ts with token ya29.secret-token and quotaProject=internal-proj-secret",
            "",
          ].join("\n"),
        );
        ctx.failTurn(
          "ACP process exited at /Users/private/repo/secret.ts: Bearer ya29.secret-token quotaProject=internal-proj-secret",
        );
      },
      status: 500,
      signInHeader: null,
      errorType: "api_error",
      message: GENERIC_FAILURE_MESSAGE,
      forbidden: [
        "quotaProject",
        "internal-proj-secret",
        "/Users/private/",
        "ya29.secret-token",
      ],
      checkRaw: (raw) => {
        expect(raw).not.toMatch(/quota/i);
      },
    },

    // regression #5b: exit-wrapper text that embeds the old startup stderr tail.
    {
      name: "regression #5b: AcpConnection exit wrapper with a startup stderr tail stays the generic 500",
      workspacePrefix: "worker-exit-wrapper-",
      sessionId: "diag-exit-wrapper",
      startup: (ctx) => {
        ctx.stderr.write(
          [
            "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.",
            "E1113 20:00:00.000002 1 startup.go:2] RESOURCE_EXHAUSTED quotaProject=internal-proj-secret",
            "",
          ].join("\n"),
        );
      },
      script: (ctx) => {
        ctx.failTurn(
          [
            "ACP request 'session/prompt' (id: 4) aborted: ACP process exited (code: 1, signal: null). Stderr tail:",
            "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.",
            "E1113 20:00:00.000002 1 startup.go:2] RESOURCE_EXHAUSTED quotaProject=internal-proj-secret",
          ].join("\n"),
        );
      },
      status: 500,
      signInHeader: null,
      errorType: "api_error",
      message: GENERIC_FAILURE_MESSAGE,
      forbidden: ["quotaProject", "internal-proj-secret"],
    },

    // regression #5b: a real process exit mid-prompt is a 502, not auth/quota.
    {
      name: "regression #5b: process exit during session/prompt returns 502 with no expired header",
      workspacePrefix: "worker-exit-event-",
      sessionId: "diag-exit-event",
      startup: (ctx) => {
        ctx.stderr.write(
          "E1113 20:00:00.000001 1 startup.go:1] You are not logged into Antigravity.\n",
        );
      },
      script: (ctx) => {
        ctx.exitProcess(1, null);
      },
      status: 502,
      signInHeader: null,
      errorType: "api_error",
    },
  ];

  /** Runs one table row: worker → response, asserting every declared field. */
  async function expectDiagnosedTurn(turnCase: DiagnosedTurnCase): Promise<void> {
    const ws = makeTempDir(turnCase.workspacePrefix);
    const worker = new AgySessionWorker(account, turnCase.sessionId, mcpServer, {
      workspaceDir: ws,
      spawnFn: () => createScriptedFakeAcpChild(ws, turnCase.script, turnCase.startup),
    });

    try {
      await worker.start();
      const res = await encodeAnthropicSseResponse(
        "gemini-4-carbon",
        worker.startPromptTurn([{ type: "text", text: "hi" }]),
      );
      expect(res.status).toBe(turnCase.status);
      expect(res.headers.get(SIGN_IN_HEADER)).toBe(turnCase.signInHeader);
      if (turnCase.retryAfter !== undefined) {
        expect(res.headers.get("retry-after")).toBe(turnCase.retryAfter);
      }

      const raw = await res.text();
      for (const needle of turnCase.forbidden ?? []) expect(raw).not.toContain(needle);
      turnCase.checkRaw?.(raw);

      const body: any = JSON.parse(raw);
      expect(body.type).toBe("error");
      expect(body.error?.type).toBe(turnCase.errorType);
      if (turnCase.message !== undefined) {
        // The fixed sentence first; the vendor's own words may follow it.
        expect(String(body.error?.message ?? "").startsWith(turnCase.message)).toBe(true);
      }
    } finally {
      await worker.close("test_done");
    }
  }

  for (const turnCase of DIAGNOSED_TURN_CASES) {
    test(turnCase.name, async () => {
      await expectDiagnosedTurn(turnCase);
    });
  }
});
