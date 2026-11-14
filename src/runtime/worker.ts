import fs from "node:fs";
import { clearPolicyBlock, markPolicyBlocked } from "../accounts/policy-block";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type EffortLevel,
  type NormalizedContentPart,
  type NormalizedMessage,
  type TokenUsageSummary,
  type ToolChoiceSpec,
  type TurnStopReason,
  type TurnStreamEvent,
} from "../types";
import { AcpConnection } from "./acp-connection";
import { measureProcessTreeRssBytes } from "./rss";
import {
  AGENT_RETRY_NOTE_MARKERS,
  AGENT_TERMINAL_MARKERS,
  CONTEXT_BUDGET_FAILURE_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  CREDIT_EXHAUSTED_FAILURE_MESSAGE,
  MODEL_UNSERVED_FAILURE_MESSAGE,
  TRANSIENT_LIMIT_FAILURE_MESSAGE,
  UPSTREAM_BUSY_FAILURE_MESSAGE,
  VENDOR_DISABLED_FAILURE_MESSAGE,
  VENDOR_POLICY_FAILURE_MESSAGE,
  TurnLogWatch,
  classifyAgentFailure,
  extractErrorEvidence,
  hasUpstreamRetryEvidence,
  looksLikeAgentRetryNotice,
  retryAfterSecondsFrom,
  stderrDelta,
  limitFreeDetail,
  tooLongVetoed,
  upstreamDetail,
  withoutLocalPaths,
} from "./diagnostics";
import {
  turnsAway,
  refusalHint,
  cloakSystemPrompt,
} from "../protocol/cloak";
import { settleStepUsage, usageFromAcpPromptResult } from "../usage/step-usage";
import { StepUsageTracker, emptyUsage } from "../usage/tracker";
import {
  spawnAgy,
  isPidAlive,
  killProcessTree,
  redactSecrets,
  type SpawnAgyOptions,
} from "../accounts/env";
import {
  SessionToolBroker,
  type ExposedToolCall,
  type ToolResultDelivery,
} from "../mcp/broker";
import { type LoopbackMcpServer } from "../mcp/http-server";
import { thinkingSignatureFor } from "../protocol/anthropic";
import { AsyncEventQueue, TurnContext } from "./turn-context";

/**
 * How long a turn may sit silent before the worker is retired.
 *
 * A 30-minute wall clock said nothing about activity: it could not tell a quiet
 * generation from a dead one, and when it fired while a tool call was
 * outstanding the local RPC timeout was taken for proof that the native prompt
 * had settled, so the next tool result started a second `session/prompt` on a
 * live native session. Two progress budgets cannot make that mistake: silence is
 * measured from the last thing `agy` actually said.
 */
const TURN_IDLE_BUDGET_MS = 10 * 60 * 1000;
/** A tool call may legitimately take far longer than a quiet generation. */
const TURN_TOOL_IDLE_BUDGET_MS = 60 * 60 * 1000;
const TURN_IDLE_TICK_MS = 30 * 1000;

export type WorkerState =
  | "STARTING"
  | "IDLE"
  | "GENERATING"
  | "AWAITING_TOOL_RESULTS"
  | "CLOSED";

export class SteerReplayNeededError extends Error {
  constructor(message = "Steer replay needed") {
    super(message);
    this.name = "SteerReplayNeededError";
  }
}

export interface ModelSelection {
  rawModelId: string;
  configModelValue: string;
  effort?: EffortLevel;
}

export interface WorkerOptions {
  spawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  minimalAgent?: boolean;
  exposeThinking?: boolean;
  cloakPrompts?: boolean;
  /**
   * `account_failover`: may Magpie answer this turn from another account of this
   * provider after this one fails? Undefined keeps the retryable statuses (what a
   * worker built on its own describes); the coordinator always resolves the option.
   */
  accountFailover?: boolean;
  workDir?: string;
  resumeSessionId?: string;
  resumeSystemHistorySeed?: string;
  systemPrompt?: string;
  systemHistorySeed?: string;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  toolChoice?: ToolChoiceSpec;
  workspaceDir?: string;
  steerCancelTimeoutMs?: number;
  steerToolCommitTimeoutMs?: number;
  /** Max bytes buffered for one turn before a slow consumer fails the turn. */
  maxTurnBufferBytes?: number;
  /** Test hook: overrides process-tree RSS sampling for this worker. */
  measureRssBytes?: () => number;
  onStateChange?: (
    worker: AgySessionWorker,
    oldState: WorkerState,
    newState: WorkerState,
  ) => void;
}

/** `ps`-based RSS sampling is throttled to this window on non-Linux hosts. */
const RSS_SAMPLE_COOLDOWN_MS = 10_000;

/** The terminal notices `agy` writes as the last thing in a failed turn. */
const AGENT_ERROR_CORES: readonly string[] = AGENT_TERMINAL_MARKERS.map((m) =>
  m.trim(),
);
const AGENT_ERROR_HELD_MAX = Math.max(...AGENT_TERMINAL_MARKERS.map((m) => m.length)) - 1;
const AGENT_RETRY_NOTES: readonly string[] = AGENT_RETRY_NOTE_MARKERS.map((m) =>
  m.trim(),
);

/** The first terminal notice this text contains, or null. */
function agentTerminalCore(text: string): string | null {
  for (const core of AGENT_ERROR_CORES) {
    if (text.includes(core)) return core;
  }
  return null;
}

/**
 * How many `agy` retry notices a turn may emit before it is ended as a
 * transient limit, while it has delivered nothing the caller could lose.
 *
 * `agy` retries a per-minute `429` in-process with exponential backoff: eight
 * observed attempts spanned ~8 minutes, well past the 300s client timeout that
 * pi and most agents use, so a caller saw one dead turn and then a cooled key
 * instead of a quick failover. Two notices (≈12s of backoff) is long enough to
 * let a blip recover and short enough to keep the caller inside its own timeout.
 */
const MAX_UPSTREAM_RETRY_NOTICES = 2;

function flattenOptions(opts: any[]): any[] {
  const result: any[] = [];
  for (const opt of opts) {
    if (opt && Array.isArray(opt.options)) {
      result.push(...flattenOptions(opt.options));
    } else {
      result.push(opt);
    }
  }
  return result;
}

const liveWorkersForExitCleanup = new Set<AgySessionWorker>();
let exitHookRegistered = false;
let staleWorkspacesSwept = false;

function ensureWorkerExitHookRegistered(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const worker of Array.from(liveWorkersForExitCleanup)) {
      try {
        worker.closeSync("process_exit");
      } catch {}
    }
  });
}

export function sweepStaleWorkspaces(now = Date.now()): number {
  let removed = 0;
  const tmpRoot = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith("agy-magpie-ws-")) continue;
    const fullPath = path.join(tmpRoot, ent.name);
    const pidFile = path.join(fullPath, ".owner-pid");
    try {
      if (fs.existsSync(pidFile)) {
        const ownerPid = Number(fs.readFileSync(pidFile, "utf-8").trim());
        if (!isPidAlive(ownerPid)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } else {
        // Legacy workspace without .owner-pid older than 1 hour
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs > 60 * 60 * 1000) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      }
    } catch {}
  }
  return removed;
}

function sweepStaleWorkspacesOnce(): void {
  if (staleWorkspacesSwept) return;
  staleWorkspacesSwept = true;
  sweepStaleWorkspaces();
}

/**
 * Builds the exact system text the worker appends to a session.
 *
 * Single source of truth: the coordinator uses it to size the history seed
 * against the same bytes the worker will actually send, so the two never drift.
 */
export function buildEffectiveSystemText(
  systemPrompt: string | undefined,
  workDir: string | undefined,
  cloak = false,
  saidAs?: string | null,
): string {
  let systemWithWorkDir = systemPrompt ?? "";
  if (workDir && !/[\r\n\0]/.test(workDir)) {
    const dirNote = buildWorkDirDisambiguationNote(workDir);
    systemWithWorkDir = systemWithWorkDir.trim()
      ? `${systemWithWorkDir}\n\n${dirNote}`
      : dirNote;
  }
  // A tool that outlives the relay delay answers "still running"; the model has
  // to know the wait protocol up front, not discover it from the notice alone.
  if (systemWithWorkDir.trim()) {
    systemWithWorkDir = `${systemWithWorkDir.trim()}\n\n${STILL_RUNNING_PROTOCOL_NOTE}`;
  } else {
    systemWithWorkDir = STILL_RUNNING_PROTOCOL_NOTE;
  }
  return cloakSystemPrompt(systemWithWorkDir, cloak, saidAs);
}

const STILL_RUNNING_PROTOCOL_NOTE =
  "When a tool result says the bridge is still running, call mcp_magpie_await_result with the call id it gave. " +
  "Do not repeat the original call, and do not end the turn before the result arrives.";

function buildWorkDirDisambiguationNote(callerWorkDir: string): string {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; where an environment given elsewhere in this conversation differs, go by the caller's instructions without checking. Never write artifacts, reports, or scratch files to <appDataDir>/brain on the bridge host; all file reads and writes must target the caller's workspace through the provided tools.`;
}

export class AgySessionWorker {
  readonly account: AccountDescriptor;
  sessionId: string;
  workspaceDir: string = "";
  readonly workDir?: string;
  readonly minimalAgent: boolean;
  effectiveSystemPrompt: string = "";
  private readonly mcpServer: LoopbackMcpServer;
  private readonly options: WorkerOptions;

  private _state: WorkerState = "STARTING";
  lastActivityAt: number = Date.now();

  broker!: SessionToolBroker;
  private child!: ChildProcessWithoutNullStreams;
  private conn!: AcpConnection;
  private mcpUrl!: string;

  nativeSessionId!: string;
  imageSupported: boolean = false;
  appendSystemSupported: boolean = false;
  resumeSupported: boolean = false;
  resumedFromShelf: boolean = false;
  configOptions: any[] = [];
  currentModelSelection?: ModelSelection;

  committedMessages: NormalizedMessage[] = [];
  registeredTools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }> = [];
  systemPrompt?: string;
  systemHistorySeedApplied: boolean = false;
  appliedSystemHistorySeed?: string;

  readonly activeAcpToolCallIds = new Set<string>();
  steerCancelTimeoutMs?: number;
  steerToolCommitTimeoutMs?: number;

  private pinLeases: number = 0;
  private capacityListener?: () => void;
  private lastRssSampleAt: number = 0;
  private lastRssBytes: number = 0;

  /**
   * A worker is held by every in-flight owner (the coordinator's turn and the
   * admission / side-request paths all take a `pin()` lease). It is evictable
   * only while no lease is outstanding.
   */
  get pinned(): boolean {
    return this.pinLeases > 0;
  }

  /**
   * Holds this worker for the caller and returns an idempotent release.
   *
   * Leases nest: overlapping holds keep the worker pinned until the last one is
   * released, and only that release wakes the scheduler's waiters.
   */
  pin(): () => void {
    this.pinLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const wasPinned = this.pinned;
      this.pinLeases = Math.max(0, this.pinLeases - 1);
      if (wasPinned && !this.pinned) {
        this.notifyCapacityChange();
      }
    };
  }

  setSchedulerCapacityListener(listener: (() => void) | undefined): void {
    this.capacityListener = listener;
  }

  /**
   * One bounded queue per turn. A consumer that stops reading fails the turn
   * instead of letting ACP stdout buffer without limit, and the overflow tears
   * the worker down so its native session state is never reused half-written.
   */
  private createTurnQueue(): AsyncEventQueue<TurnStreamEvent> {
    this.retryStormAborted = false;
    this.upstreamRetryCorroborated = false;
    return this.turn.beginTurnQueue({
      maxBufferedBytes: this.options.maxTurnBufferBytes,
      onOverflow: () => {
        // The queue has already error-and-closed itself, so the producer that
        // overflowed it can unwind first. Tearing the worker down synchronously
        // would clear the turn's queue mid-`push()` and make the caller's own
        // bookkeeping observe `null` from inside an unobserved promise chain.
        queueMicrotask(() => {
          void this.close("turn_buffer_overflow");
        });
      },
    });
  }

  private notifyCapacityChange(): void {
    try {
      this.capacityListener?.();
    } catch {}
  }

  private readonly turn = new TurnContext();
  private readonly usage = new StepUsageTracker();
  private unsubscribeSessionUpdate?: () => void;
  private unregisterMcp?: () => void;
  private isClosed = false;
  private readonly toolCommitWaiters = new Set<() => void>();
  private turnLogs: TurnLogWatch | null = null;
  private turnStderrBaseline: string = "";
  /** One retry-storm abort per turn; later notices of the same turn are moot. */
  private retryStormAborted = false;
  /** Set once this turn's log proves `agy` retried upstream (see diagnostics). */
  private upstreamRetryCorroborated = false;
  private readonly ownsWorkspaceDir: boolean;

  constructor(
    account: AccountDescriptor,
    sessionId: string,
    mcpServer: LoopbackMcpServer,
    options?: WorkerOptions,
  ) {
    this.account = account;
    this.sessionId = sessionId;
    this.mcpServer = mcpServer;
    this.options = options ?? {};
    this.workDir = this.options.workDir;
    this.minimalAgent = Boolean(this.options.minimalAgent);
    this.steerCancelTimeoutMs = this.options.steerCancelTimeoutMs;
    this.steerToolCommitTimeoutMs = this.options.steerToolCommitTimeoutMs;

    ensureWorkerExitHookRegistered();
    sweepStaleWorkspacesOnce();

    if (this.options.workspaceDir) {
      this.workspaceDir = this.options.workspaceDir;
      this.ownsWorkspaceDir = false;
    } else {
      this.ownsWorkspaceDir = true;
    }
  }

  private ensureWorkspaceDir(): string {
    if (this.workspaceDir) return this.workspaceDir;
    this.workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agy-magpie-ws-"),
    );
    try {
      fs.chmodSync(this.workspaceDir, 0o700);
      fs.writeFileSync(
        path.join(this.workspaceDir, ".owner-pid"),
        `${process.pid}\n`,
        { mode: 0o600 },
      );
    } catch {}
    liveWorkersForExitCleanup.add(this);
    return this.workspaceDir;
  }

  get state(): WorkerState {
    return this._state;
  }

  /** True once `closeSync` has run and the process tree is being torn down. */
  get closed(): boolean {
    return this.isClosed;
  }

  setExposeThinking(enabled: boolean): void {
    this.options.exposeThinking = enabled;
    if (!enabled) {
      this.turn.resetThinking();
    }
  }

  private turnIdleTimer: ReturnType<typeof setInterval> | null = null;
  private turnProgressAt = 0;

  /**
   * Starts the progress watchdog for a turn. Every chunk and every delivered
   * tool result re-arms it; only silence retires the worker.
   */
  private armTurnIdleWatchdog(): void {
    this.turnProgressAt = Date.now();
    if (this.turnIdleTimer !== null) return;
    this.turnIdleTimer = setInterval(() => this.checkTurnIdle(), TURN_IDLE_TICK_MS);
    (this.turnIdleTimer as { unref?: () => void }).unref?.();
  }

  private noteTurnProgress(): void {
    this.turnProgressAt = Date.now();
  }

  private stopTurnIdleWatchdog(): void {
    if (this.turnIdleTimer === null) return;
    clearInterval(this.turnIdleTimer);
    this.turnIdleTimer = null;
  }

  private checkTurnIdle(): void {
    if (this._state === "IDLE" || this._state === "STARTING") {
      this.stopTurnIdleWatchdog();
      return;
    }
    if (this.isClosed) {
      this.stopTurnIdleWatchdog();
      return;
    }
    const budget =
      this._state === "AWAITING_TOOL_RESULTS"
        ? TURN_TOOL_IDLE_BUDGET_MS
        : TURN_IDLE_BUDGET_MS;
    if (Date.now() - this.turnProgressAt < budget) return;
    // Retire rather than settle the turn: a local timeout is not proof that the
    // native prompt stopped, and a second prompt on a live native session answers
    // with whatever the first generation is still doing.
    void this.close("turn_idle_timeout");
  }

  private setState(newState: WorkerState): void {
    if (this._state === newState) return;
    if (this._state === "CLOSED") return;
    const oldState = this._state;
    this._state = newState;
    this.lastActivityAt = Date.now();
    this.options.onStateChange?.(this, oldState, newState);
    if (newState === "IDLE" || newState === "CLOSED") {
      this.notifyCapacityChange();
    }
  }

  /**
   * Resident-set size of this worker's process tree, in bytes. Returns `0` when
   * the tree is gone or the platform cannot be sampled.
   */
  getRssBytes(now = Date.now()): number {
    if (this.options.measureRssBytes) {
      try {
        return this.options.measureRssBytes();
      } catch {
        return 0;
      }
    }

    const pid = this.child?.pid;
    if (!pid || this.isClosed || this.child.exitCode !== null) return 0;

    // `/proc` is cheap to read on every turn; `ps` is not, so a session that
    // makes several quick turns must reuse one sample for a short window.
    if (process.platform === "linux") {
      return measureProcessTreeRssBytes(pid);
    }
    if (now - this.lastRssSampleAt < RSS_SAMPLE_COOLDOWN_MS) {
      return this.lastRssBytes;
    }
    const bytes = measureProcessTreeRssBytes(pid);
    this.lastRssSampleAt = now;
    this.lastRssBytes = bytes;
    return bytes;
  }

  /**
   * Retires the worker (when `closeReason` is given) and throws the bridge's
   * standard 499 abort error. Never returns, so call sites do not need a
   * trailing `throw` of their own.
   */
  private async throwAborted(
    closeReason?: string,
    message = "Request aborted during startup",
  ): Promise<never> {
    if (closeReason) {
      await this.close(closeReason);
    }
    throw new BridgeHttpError(499, "invalid_request_error", message);
  }

  /**
   * Turns a sign-in failure surfaced by a startup RPC into the bridge's 401 and
   * retires the worker; anything else is rethrown unchanged.
   */
  private async failIfAuthExpired(err: unknown): Promise<never> {
    const stderr = this.conn.getStderrTail();
    const combined = `${(err as any)?.message || ""}\n${stderr}`;
    if (
      /please sign in|not (?:logged|signed) in|authentication expired|login required|unauthenticated/i.test(
        combined,
      )
    ) {
      await this.close("auth_expired");
      throw new BridgeHttpError(
        401,
        "authentication_error",
        "Antigravity CLI authentication expired. Please sign in again.",
        { signInExpired: true },
      );
    }
    throw err;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      await this.throwAborted("aborted_startup");
    }

    let abortHandler: (() => void) | null = null;
    if (signal) {
      abortHandler = () => {
        void this.close("aborted_startup");
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      this.ensureWorkspaceDir();
      liveWorkersForExitCleanup.add(this);
      // 1. Write agent manifest
      const agentDir = path.join(
        this.workspaceDir,
        ".agents",
        "agents",
        "magpie-bridge",
      );
      fs.mkdirSync(agentDir, { recursive: true });

      const minimalAgent = this.minimalAgent;
      const agentContent = [
        "---",
        "name: magpie-bridge",
        "description: Bridges only client-declared tools",
        "mainAgent: true",
        "subagent: false",
        "tools: []",
        "inheritMcp: false",
        "inheritCustomizations: false",
        `excludeDefaultComponents: ${minimalAgent ? "true" : "false"}`,
        "---",
        "Use only the provided MCP tools when tools are needed. Never output raw XML/JSON tool-call markup as text. Never write artifacts, reports, or scratch files to <appDataDir>/brain or the bridge's temporary workspace; write files only in the caller's workspace when requested.",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(agentDir, "agent.md"), agentContent, "utf-8");

      // 2. Initialize SessionToolBroker
      this.broker = new SessionToolBroker({
        batchWindowMs: 25,
        callDeadlineMs:
          Number(process.env.AGY_BRIDGE_TOOL_TIMEOUT_MS) || 15 * 60 * 1000,
        onBatchReady: (calls: ExposedToolCall[]) => {
          this.handleBatchReady(calls);
        },
        onFatalToolLoop: (reason: string) => {
          this.handleFatalToolLoop(reason);
        },
        onCallExpired: () => {
          void this.close("tool_call_deadline_expired");
        },
      });

      if (this.options.tools) {
        this.registeredTools = [...this.options.tools];
        this.broker.setTools(this.options.tools);
      }
      if (this.options.toolChoice) {
        this.broker.setToolChoice(this.options.toolChoice);
      }
      if (this.options.systemPrompt) {
        this.systemPrompt = this.options.systemPrompt;
      }

      // 3. Register broker on LoopbackMcpServer
      const reg = this.mcpServer.registerSession(this.broker);
      this.unregisterMcp = reg.unregister;
      this.mcpUrl = reg.url;

      // 4. Spawn agy ACP
      const logFile = path.join(this.workspaceDir, "agy-acp.log");
      // One Go process per session. `--process-per-session` forked a second
      // process (~54% more RSS) and split the real failure log into
      // `agy-acp.log.<pid>`, but plain `--stdio` without it is *not*
      // equivalent either: measured on `agy 1.5.8`, the bare front server omits
      // `mcpCapabilities.http` and silently drops the session's HTTP
      // `mcpServers`, so no caller tool can ever reach `agy`. `--worker` runs the
      // single-process session server directly and keeps every capability the
      // bridge relies on (`mcpCapabilities.http`, `--add-dir`,
      // `_meta.antigravity.systemPrompt.append`, `session/resume`).
      const args = [
        "acp",
        "--agent",
        "magpie-bridge",
        "--stdio",
        "--worker",
        "--disable-telemetry",
        "--log-file",
        logFile,
      ];
      if (
        this.options.workDir &&
        path.isAbsolute(this.options.workDir) &&
        !/[\r\n\0]/.test(this.options.workDir)
      ) {
        try {
          if (fs.statSync(this.options.workDir).isDirectory()) {
            args.push("--add-dir", this.options.workDir);
          }
        } catch {}
      }

      if (this.options.spawnFn) {
        this.child = this.options.spawnFn(this.account, args, {
          cwd: this.workspaceDir,
        });
      } else {
        this.child = spawnAgy(this.account, args, {
          cwd: this.workspaceDir,
        });
      }

      this.conn = new AcpConnection(this.child, {
        redactor: redactSecrets,
        onExit: () => {
          if (!this.isClosed) {
            void this.close("acp_process_exited");
          }
        },
      });
      this.setupAcpListeners();

      if (signal?.aborted) {
        await this.throwAborted("aborted_startup");
      }

      // 5. ACP initialize
      let initRes: any;
      try {
        initRes = await this.conn.request("initialize", {
          protocolVersion: 1,
          clientInfo: {
            name: "agy-acp",
            version: "0.1.0",
          },
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
            terminal: false,
          },
        });
      } catch (err: any) {
        await this.failIfAuthExpired(err);
      }

      if (signal?.aborted) {
        await this.throwAborted("aborted_startup");
      }

      this.imageSupported = Boolean(
        (initRes as any)?.agentCapabilities?.promptCapabilities?.image,
      );
      this.appendSystemSupported = Boolean(
        (initRes as any)?.agentCapabilities?._meta?.antigravity?.systemPrompt
          ?.append,
      );
      this.resumeSupported = Boolean(
        (initRes as any)?.agentCapabilities?.loadSession ||
          (initRes as any)?.agentCapabilities?.sessionCapabilities?.resume,
      );

      // ACP asks a client to check the agent's HTTP support before offering an
      // HTTP MCP server. When `agy` says it has none, it drops the session's
      // `mcpServers` without a word and every tool call fails as if the model had
      // refused; say so here, with the version, instead of failing later.
      const httpMcp = (initRes as any)?.agentCapabilities?.mcpCapabilities?.http;
      if (httpMcp === false) {
        const version = String((initRes as any)?.agentInfo?.version ?? "unknown");
        throw new Error(
          `agy ${version} does not accept HTTP MCP servers (agentCapabilities.mcpCapabilities.http is false), so no caller tool can reach it; update agy to a version that does`,
        );
      }

      // Cloak system prompt
      const effectiveSystem = buildEffectiveSystemText(
        this.options.systemPrompt,
        this.options.workDir,
        this.options.cloakPrompts === true,
      );
      this.effectiveSystemPrompt = effectiveSystem;

      // 6. ACP session/resume or session/new
      let sessionRes: any = null;
      if (this.options.resumeSessionId && this.resumeSupported) {
        try {
          const resumeParams: Record<string, unknown> = {
            sessionId: this.options.resumeSessionId,
            cwd: this.workspaceDir,
            mcpServers: [
              { name: "magpie", type: "http", url: this.mcpUrl, headers: [] },
            ],
          };
          if (this.appendSystemSupported) {
            const resumeSystem = [
              effectiveSystem,
              this.options.resumeSystemHistorySeed,
            ]
              .filter(Boolean)
              .join("\n\n");
            if (resumeSystem) {
              resumeParams._meta = {
                antigravity: {
                  systemPrompt: {
                    append: resumeSystem,
                  },
                },
              };
            }
          }
          sessionRes = await this.conn.request("session/resume", resumeParams);
          this.resumedFromShelf = true;
          if (this.appendSystemSupported && this.options.resumeSystemHistorySeed) {
            this.appliedSystemHistorySeed = this.options.resumeSystemHistorySeed;
          }
          this.nativeSessionId =
            sessionRes?.sessionId || this.options.resumeSessionId;
          this.usage.syncExistingConversation(
            this.account,
            this.nativeSessionId,
          );
        } catch {
          this.resumedFromShelf = false;
        }
      }

      if (!sessionRes) {
        const newParams: Record<string, unknown> = {
          cwd: this.workspaceDir,
          mcpServers: [
            { name: "magpie", type: "http", url: this.mcpUrl, headers: [] },
          ],
        };

        if (this.appendSystemSupported) {
          const newSessionSystem = [
            effectiveSystem,
            this.options.systemHistorySeed,
          ]
            .filter(Boolean)
            .join("\n\n");
          if (newSessionSystem) {
            newParams._meta = {
              antigravity: {
                systemPrompt: {
                  append: newSessionSystem,
                },
              },
            };
          }
          if (this.options.systemHistorySeed) {
            this.systemHistorySeedApplied = true;
            this.appliedSystemHistorySeed = this.options.systemHistorySeed;
          }
        }

        try {
          sessionRes = await this.conn.request("session/new", newParams);
          this.nativeSessionId =
            (sessionRes as any)?.sessionId || this.sessionId;
        } catch (err: any) {
          await this.failIfAuthExpired(err);
        }
      }

      if (Array.isArray((sessionRes as any)?.configOptions)) {
        this.configOptions = (sessionRes as any).configOptions;
      }

      if (signal?.aborted) {
        await this.throwAborted("aborted_startup");
      }

      this.setState("IDLE");
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private setupAcpListeners(): void {
    this.unsubscribeSessionUpdate = this.conn.onSessionUpdate((params: any) => {
      this.handleSessionUpdate(params);
    });
  }

  private handleSessionUpdate(rawParams: any): void {
    if (!rawParams) return;
    // Anything `agy` says is progress, including output this turn will not
    // forward (a suppressed steer, a retry notice, a tool-call update).
    this.noteTurnProgress();
    // A steered-cancel turn and an aborted retry-storm turn both drop output:
    // the caller was already told, or is about to be, that this turn is over.
    if (this.turn.suppressingSteerCancel || this.retryStormAborted) {
      const update = rawParams?.update ?? rawParams;
      if (update?.sessionUpdate === "tool_call_update") {
        const callId = update.toolCallId ?? update.id;
        if (update.status === "completed" || update.status === "failed") {
          if (callId) {
            this.activeAcpToolCallIds.delete(callId);
          }
          this.notifyToolCallUpdated();
        }
      }
      return;
    }
    if (
      rawParams?.sessionId &&
      this.nativeSessionId &&
      rawParams.sessionId !== this.nativeSessionId
    ) {
      return;
    }
    const update = rawParams?.update ?? rawParams;
    const updateType = update.sessionUpdate;

    if (updateType === "agent_message_chunk") {
      const chunk = update.content?.text ?? update.text ?? "";
      if (!chunk) return;

      // `agy` streams its own retry notices into the reply. They are
      // diagnostics, not model output, so they are counted and kept out of the
      // answer; a storm of them ends the turn as a transient limit. A model can
      // also *quote* the same lines ("explain this error"), so nothing is
      // stripped, counted or cancelled unless this turn's own log says `agy`
      // really retried. That record may land one chunk late, so a notice-shaped
      // chunk is held rather than delivered while the question is open.
      // A held candidate plus this chunk decides together: the second half of a
      // split notice is usually ordinary prose on its own.
      const pending = this.turn.pendingNoticeText;
      const looksNotice = looksLikeAgentRetryNotice(pending + chunk);
      if (looksNotice && !this.upstreamRetryCorroborated) {
        // Reading the turn log is only worth it when a notice is in play.
        this.hasCorroboratedUpstreamRetry();
      }

      let absorbed: { text: string; notices: number } = { text: "", notices: 0 };
      if (this.upstreamRetryCorroborated) {
        absorbed = this.turn.absorbRetryNotices(chunk);
      } else if (
        looksNotice &&
        !this.turn.deliveredWork &&
        this.turn.holdNoticeCandidate(chunk)
      ) {
        return;
      } else {
        // Anything held while in doubt is answer text now.
        absorbed.text = this.turn.flushRetryNoticeHold() + chunk;
      }

      let text = this.turn.heldText + absorbed.text;
      this.turn.heldText = "";

      // agy's "retry me" note is its own, not the model's: the turn goes on.
      for (const note of AGENT_RETRY_NOTES) {
        if (text.includes(note)) text = text.split(note).join("\n");
      }

      const terminal = agentTerminalCore(text);
      const marker = terminal === null ? -1 : text.lastIndexOf(terminal);
      if (marker >= 0 && terminal !== null && !text.slice(marker + terminal.length).trim()) {
        const start = text[marker - 1] === "\n" ? marker - 1 : marker;
        this.turn.heldText = text.slice(start);
        text = text.slice(0, start);
        if (text) this.turn.pushEvent({ type: "text_delta", text });
        return;
      }

      for (let keep = Math.min(text.length, AGENT_ERROR_HELD_MAX); keep > 0; keep--) {
        const tail = text.slice(-keep);
        if (
          AGENT_TERMINAL_MARKERS.some((m) => m.startsWith(tail)) ||
          AGENT_RETRY_NOTES.some((m) => m.startsWith(tail))
        ) {
          this.turn.heldText = tail;
          text = text.slice(0, -keep);
          break;
        }
      }

      // Deliver whatever text survived this chunk first: a chunk that also
      // carried real output has already given the caller something, so the
      // storm guard below must see it and stand down.
      if (text) this.turn.pushEvent({ type: "text_delta", text });

      if (absorbed.notices > 0 && this.shouldAbortUpstreamRetryStorm()) {
        this.abortUpstreamRetryStorm();
      }
    } else if (updateType === "agent_thought_chunk") {
      const thinking = update.content?.text ?? update.text ?? "";
      if (
        this.options.exposeThinking !== false &&
        this.turn.queueOpen &&
        thinking
      ) {
        this.turn.appendThinking(thinking);
      }
    } else if (updateType === "tool_call") {
      const callId = update.toolCallId ?? update.id;
      if (callId) {
        this.activeAcpToolCallIds.add(callId);
      }
    } else if (updateType === "tool_call_update") {
      const callId = update.toolCallId ?? update.id;
      if (update.status === "completed" || update.status === "failed") {
        if (callId) {
          this.activeAcpToolCallIds.delete(callId);
        }
        this.notifyToolCallUpdated();
      }
    } else if (updateType === "config_option_update") {
      if (Array.isArray(update.configOptions)) {
        this.configOptions = update.configOptions;
      } else if (update.configOption) {
        const idx = this.configOptions.findIndex(
          (o: any) => o.id === update.configOption.id,
        );
        if (idx >= 0) {
          this.configOptions[idx] = update.configOption;
        } else {
          this.configOptions.push(update.configOption);
        }
      }
    }
  }

  private notifyToolCallUpdated(): void {
    for (const waiter of this.toolCommitWaiters) {
      waiter();
    }
  }

  /**
   * Snapshots the diagnostics window for the turn that is about to start.
   *
   * The stderr baseline is taken *before* `session/prompt` because `agy` logs
   * a burst of start-up `E ... You are not logged into Antigravity.` records
   * while its token source is still warming up; a whole-buffer read would
   * attribute them to this turn and fabricate a `401`.
   */
  private markTurnDiagnosticsStart(): void {
    try {
      this.turnStderrBaseline = this.conn?.getStderrTail() ?? "";
    } catch {
      this.turnStderrBaseline = "";
    }
    try {
      this.turnLogs = new TurnLogWatch(this.workspaceDir);
      this.turnLogs.markTurnStart();
    } catch {
      this.turnLogs = null;
    }
  }

  /**
   * Error evidence written since this turn started, from the front log and
   * every `agy-acp.log.<pid>` session-worker log in this workspace.
   *
   * Without this, a forked session worker hid every real failure: the front
   * process logs only `front: session/prompt`, while the executor error is
   * written by the per-session worker into its own numbered log.
   */
  /**
   * A model can quote one of `agy`'s notices — a caller asking what an error
   * means gets the notice back as the whole answer — so the held words only
   * become this turn's failure when the turn's own log names the *same* failure.
   * Nothing having preceded them is no proof, and any error line is not the same
   * error: either mistake rests a healthy account (402 is a 30-minute credit
   * rest) and hides the answer.
   */
  private terminalNoticeIsEvidence(notice: string): boolean {
    const fromNotice = classifyAgentFailure("", notice);
    // What a false positive costs decides how much corroboration is needed. The
    // generic marker answers a 500 and the dead-connection one a 503, which rests
    // the model for 30 seconds and counts no failure: both are the vendor saying
    // the turn died, so they are taken at their word even when the log is empty.
    if (fromNotice === "internal" || fromNotice === "upstream_busy") return true;
    // The vendor's suspension sentence is what a suspended account answers with,
    // and nothing else in the turn corroborates it. It is taken at its word only
    // when it is the whole answer: a model writing it after prose is quoting it.
    if (fromNotice === "vendor_restricted" && !this.turn.deliveredWork) return true;
    // A false 402 rests the account for half an hour, so the spent-credit notice
    // needs the turn's own log to name the same failure first.
    const evidence = this.currentTurnLogEvidence();
    if (!evidence) return false;
    return classifyAgentFailure(evidence, "") === fromNotice;
  }

  private currentTurnLogEvidence(): string {
    try {
      // No mark means no turn window (diagnosis before any prompt): read the
      // bounded tail rather than the whole file so nothing unbounded is loaded.
      const watch = this.turnLogs ?? new TurnLogWatch(this.workspaceDir);
      return extractErrorEvidence(watch.readTurnEvidence());
    } catch {
      return "";
    }
  }

  /**
   * True once this turn's raw log (unfiltered, `I` records included) shows
   * `agy` retrying upstream. Checked lazily the first time a notice-shaped line
   * arrives in the stream, then cached for the rest of the turn.
   */
  private hasCorroboratedUpstreamRetry(): boolean {
    if (this.upstreamRetryCorroborated) return true;
    try {
      const watch = this.turnLogs ?? new TurnLogWatch(this.workspaceDir);
      this.upstreamRetryCorroborated = hasUpstreamRetryEvidence(
        watch.readTurnEvidence(),
      );
    } catch {
      this.upstreamRetryCorroborated = false;
    }
    return this.upstreamRetryCorroborated;
  }

  private diagnoseTerminationError(
    rawErr?: unknown,
  ): Extract<TurnStreamEvent, { type: "error" }> {
    const rawErrMsg =
      rawErr instanceof Error
        ? rawErr.message
        : rawErr !== undefined && rawErr !== null
          ? String(rawErr)
          : "";
    const redactedRawErr = redactSecrets(rawErrMsg);

    let stderrEvidence = "";
    try {
      stderrEvidence = extractErrorEvidence(
        stderrDelta(this.turnStderrBaseline, this.conn?.getStderrTail() ?? ""),
      );
    } catch {
      stderrEvidence = "";
    }

    const evidence = [this.currentTurnLogEvidence(), stderrEvidence]
      .filter(Boolean)
      .join("\n");

    // Log records and turn-scoped stderr are merged as evidence; the ACP error
    // text is passed separately because it is authoritative for this turn and
    // may therefore state auth in wording that a log must not trust.
    const verdict = classifyAgentFailure(evidence, redactedRawErr);

    // A suspended account refuses every prompt the same way, so remember it and
    // let later turns fail fast instead of spawning `agy` to be refused again.
    if (verdict === "vendor_restricted") {
      markPolicyBlocked(this.account.accountRef, VENDOR_DISABLED_FAILURE_MESSAGE);
    }

    // The vendor's own words, appended after the fixed sentence: the verdict is
    // what Magpie routes on, the detail is what a human reads. Bounded, one line,
    // secrets already redacted above.
    // Every byte that can reach the client is redacted and stripped of local
    // paths: the log tail is not redacted where it is read.
    const upstreamText = withoutLocalPaths(
      redactSecrets([redactedRawErr, evidence].filter(Boolean).join(" ")),
    );
    const rawDetail = upstreamDetail(upstreamText);
    // A detail on a verdict that is *not* about limits must not carry limit
    // wording: Magpie reads the whole body, so an echoed "quota" in a 400 or 403
    // would be taken for a spent window and hold the account.
    const limitFree = limitFreeDetail(upstreamText);
    const withDetail = (message: string, detail = limitFree) =>
      detail ? `${message} Upstream said: ${detail}` : message;
    // A `Retry-After` for what the refusal named, so a client that honors it does
    // not come back before the upstream will answer.
    const retryAfterSeconds = retryAfterSecondsFrom(
      `${redactedRawErr}\n${evidence}`,
    );

    switch (verdict) {
      case "context_budget":
        // `agy` refused to serialize the trajectory (`maxMessageTokens must be
        // positive, got 0`). A `400` saying the conversation is too long is how
        // Magpie reads a prompt the model can't hold: it asks a member with room,
        // rests no account, and tells the agent to compact. The same conversation
        // is too long on every account, so failing over only repeated it.
        return {
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          message: withDetail(
            CONTEXT_BUDGET_FAILURE_MESSAGE,
            tooLongVetoed(upstreamText) ? "" : limitFree,
          ),
        };
      case "vendor_restricted":
        // The account itself is suspended. Its words keep the vendor's own sentence
        // so Magpie reads the suspension (`googleToS`) rather than walling the
        // provider off for the request.
        return {
          type: "error",
          status: this.failoverStatus(403),
          errorType: "permission_error",
          message: withDetail(VENDOR_DISABLED_FAILURE_MESSAGE),
        };
      case "vendor_policy":
        // Permission denied for the account, not the prompt.
        return {
          type: "error",
          status: this.failoverStatus(403),
          errorType: "permission_error",
          message: withDetail(VENDOR_POLICY_FAILURE_MESSAGE),
        };
      case "model_unserved":
        // A `404` whose words say the model is not found: Magpie rests that model
        // on this account alone and keeps asking it for the others (#1235).
        return {
          type: "error",
          status: 404,
          errorType: "not_found_error",
          message: withDetail(MODEL_UNSERVED_FAILURE_MESSAGE),
        };
      case "upstream_busy":
        // The vendor's own servers: a `503` saying "overloaded" rests the account
        // for 30 seconds without counting a failure on its ladder, because the
        // next request would meet the same thing.
        return {
          type: "error",
          status: 503,
          errorType: "api_error",
          message: withDetail(UPSTREAM_BUSY_FAILURE_MESSAGE),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
      case "auth":
        return {
          type: "error",
          status: this.failoverStatus(401),
          errorType: "authentication_error",
          message: withDetail(
            "Antigravity CLI authentication expired. Please sign in again.",
          ),
          signInExpired: true,
        };
      case "quota":
        // A window named as spent is evidence about the account, so it is not
        // read as a refused prompt (that answer names no window).
        return {
          type: "error",
          status: this.failoverStatus(429),
          errorType: "rate_limit_error",
          message: withDetail("Account quota exhausted", rawDetail),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
      case "rate_limit":
        // A `429` that names no spent window: `agy` retries these in-process, so
        // this is what a busy minute looks like. Reported as a plain `429` with
        // text free of quota wording, so Magpie rests the account briefly and
        // asks the next one instead of holding it for its whole window.
        // Nothing asked for the rewording to be off: a turned-away line here is
        // the likeliest explanation, and cloaking that still met a `429` failed at
        // it. Both answer `400`, which stops the next account from being asked.
        if (turnsAway(this.systemPrompt)) {
          return {
            type: "error",
            status: 400,
            errorType: "invalid_request_error",
            message: refusalHint(this.systemPrompt),
          };
        }
        return this.transientLimitError(
          limitFreeDetail(upstreamText),
          retryAfterSeconds,
          this.failoverStatus(429),
        );
      case "credit_exhausted":
        // A `402` is out of credit to Magpie: the account is held on that ladder
        // rather than a quota window's, and topping up is what clears it.
        return {
          type: "error",
          status: this.failoverStatus(402),
          errorType: "api_error",
          message: withDetail(CREDIT_EXHAUSTED_FAILURE_MESSAGE, rawDetail),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
      case "invalid_request":
        return {
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          message: withDetail("Invalid request to agent"),
        };
      default:
        // Never echo the raw error: for a process exit it carries the whole
        // stderr tail, whose `quotaProject=` metadata would make Magpie rest a
        // healthy account.
        return {
          type: "error",
          status: 500,
          errorType: "api_error",
          message: GENERIC_FAILURE_MESSAGE,
        };
    }
  }

  /**
   * The turn is only spinning through `agy`'s in-process retry ladder: at least
   * {@link MAX_UPSTREAM_RETRY_NOTICES} notices seen and nothing delivered yet, so
   * ending it loses no work the caller could have had.
   */
  private shouldAbortUpstreamRetryStorm(): boolean {
    return (
      !this.retryStormAborted &&
      !this.turn.deliveredWork &&
      this.turn.upstreamRetryNotices >= MAX_UPSTREAM_RETRY_NOTICES
    );
  }

  /** The fixed `429` event for a transient upstream limit (see the message doc). */
  private transientLimitError(
    detail?: string,
    retryAfterSeconds?: number,
    status = 429,
  ): Extract<TurnStreamEvent, { type: "error" }> {
    return {
      type: "error",
      status,
      errorType: "rate_limit_error",
      message: detail
        ? `${TRANSIENT_LIMIT_FAILURE_MESSAGE} Upstream said: ${detail}`
        : TRANSIENT_LIMIT_FAILURE_MESSAGE,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  /**
   * The status Magpie's router reads for this account's own failure.
   *
   * A `401`, a `402`, a `403` and a `429` all let it ask the next account of this
   * provider (`fallback.go` `retryable`), so one failure becomes a request to every
   * account in the pool — which is what a prompt the vendor turns away draws, and
   * what the terms call automating account rotation. With `account_failover` off
   * (the default) the failure stops at the account that met it: `409`, which
   * `retryable` does not list, carrying the same words and the same `error.type`
   * (Magpie's own taxonomy reads the words, not the status).
   */
  private failoverStatus(normal: number): number {
    return this.options.accountFailover === false ? 409 : normal;
  }

  /**
   * Ends a turn that is still retrying upstream instead of waiting out `agy`'s
   * full ladder (~8 minutes, far past the client's own timeout). `agy` is told to
   * cancel so the worker stays reusable, and the caller gets a plain `429` it can
   * fail over on.
   */
  private abortUpstreamRetryStorm(): void {
    if (this._state !== "GENERATING" || this.retryStormAborted) return;
    this.retryStormAborted = true;

    // Detach the turn's queue *before* cancelling. `agy` settles the cancelled
    // `session/prompt` as an error (`context canceled`) whose only log evidence
    // is the `I`-severity retry records, so letting that settlement finish the
    // turn would report a generic 500 and climb the caller's failure backoff.
    // Taking the queue also means nothing `agy` streams while the cancel travels
    // can reach the caller ahead of the `429`.
    // Read the failure before cancelling: the cancel writes its own
    // `context canceled` records, and what the storm is about is the attempt that
    // just failed. Its class is kept — a 503 stays a 503, a named spent window
    // stays a spent window — instead of answering every storm as a throttle.
    const diagnosed = this.diagnoseTerminationError(
      this.turn.upstreamRetryNoticeText || undefined,
    );
    const queue = this.turn.takeQueue();
    const prompt = this.turn.pendingPrompt;
    this.turn.nextPromptEpoch();

    try {
      this.conn.notify("session/cancel", {
        sessionId: this.nativeSessionId,
      });
      this.broker.cancelAll("Upstream retry storm");
    } catch {}

    void (async () => {
      // Wait for the native cancel so a retry on this worker does not meet a
      // stale GENERATING state, then hand over the fixed error and close.
      const settled = await this.settleOrTimeout(prompt, 1500);
      this.turn.pendingPrompt = null;
      if (queue) {
        queue.push(diagnosed);
        queue.close();
      }
      if (!settled) {
        await this.close("retry_storm_cancel_timeout");
      } else if (this._state === "GENERATING") {
        this.setState("IDLE");
      }
    })();
  }

  private handleFatalToolLoop(reason: string): void {
    this.turn.finishWith({
      type: "error",
      status: 500,
      errorType: "api_error",
      message: `Fatal tool loop detected: ${reason}`,
    });
    void this.close("fatal_tool_loop");
  }

  private handleBatchReady(calls: ExposedToolCall[]): void {
    const q = this.turn.takeQueue();
    if (!q) return;

    // 1. If thinking accumulated, yield thinking signature
    if (this.options.exposeThinking !== false) {
      const thinking = this.turn.consumeThinkingForSignature();
      if (thinking.length > 0) {
        q.push({
          type: "thinking_signature",
          signature: thinkingSignatureFor(this.sessionId, thinking),
        });
      }
    } else {
      this.turn.resetThinking();
    }

    // 2. Yield tool_use events
    for (const call of calls) {
      this.turn.markDelivered();
      q.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }

    // 3. Transition worker state: GENERATING -> AWAITING_TOOL_RESULTS
    this.usage.incrementPromptStepCount();
    this.setState("AWAITING_TOOL_RESULTS");

    // 4. Settle per-step usage from agy's SQLite WAL (with micro-backoff if the
    // conversation DB exists on disk and the current step WAL frame is mid-flush)
    void this.settleAndCloseBatchTurn(q);
  }

  private async settleAndCloseBatchTurn(
    q: AsyncEventQueue<TurnStreamEvent>,
  ): Promise<void> {
    let toolStepUsage: TokenUsageSummary = emptyUsage();
    try {
      const dbSteps = await this.usage.readUnseenStepsWithRetry(
        this.account,
        this.nativeSessionId,
        3,
        25,
        { isClosed: () => this._state === "CLOSED" },
      );
      if (dbSteps.length > 0) {
        toolStepUsage = settleStepUsage(undefined, 1, [
          dbSteps[dbSteps.length - 1]!,
        ]);
      }
    } catch {}

    this.usage.noteTurnReported(toolStepUsage);

    try {
      q.push({
        type: "finish",
        stopReason: "tool_use",
        usage: toolStepUsage,
      });
    } finally {
      q.close();
    }
  }

  async applyModelSelection(
    selection: ModelSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      await this.throwAborted(undefined, "Request aborted");
    }

    const modelOpt = this.configOptions.find(
      (o: any) => o.id === "model" || o.category === "model",
    );
    let modelConfigApplied = false;

    if (modelOpt) {
      try {
        if (
          this.currentModelSelection?.configModelValue !==
          selection.configModelValue
        ) {
          const res: any = await this.conn.request("session/set_config_option", {
            sessionId: this.nativeSessionId,
            configId: modelOpt.id || "model",
            value: selection.configModelValue,
          });
          if (Array.isArray(res?.configOptions)) {
            this.configOptions = res.configOptions;
          }
        }
        const updatedModelOpt = this.configOptions.find(
          (o: any) => o.id === "model" || o.category === "model",
        );
        if (
          !updatedModelOpt ||
          updatedModelOpt.currentValue === undefined ||
          updatedModelOpt.currentValue === selection.configModelValue
        ) {
          modelConfigApplied = true;
        }

        if (selection.effort) {
          const thoughtOpt = this.configOptions.find(
            (o: any) =>
              o.id === "thought_level" || o.category === "thought_level",
          );
          if (thoughtOpt) {
            let chosenEffort: string = selection.effort;
            const flattened = Array.isArray(thoughtOpt.options)
              ? flattenOptions(thoughtOpt.options)
              : [];
            const offered = flattened.map((opt: any) =>
              typeof opt === "string" ? opt : opt.id || opt.value,
            );
            if (offered.length > 0 && !offered.includes(chosenEffort)) {
              const effortLevels: EffortLevel[] = [
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ];
              const targetIdx = effortLevels.indexOf(
                chosenEffort as EffortLevel,
              );
              let closest = offered[0];
              let minDistance = 999;
              for (const off of offered) {
                const offIdx = effortLevels.indexOf(off as EffortLevel);
                const dist =
                  offIdx >= 0 && targetIdx >= 0
                    ? Math.abs(offIdx - targetIdx)
                    : 999;
                if (dist < minDistance) {
                  minDistance = dist;
                  closest = off;
                }
              }
              chosenEffort = closest;
            }

            const tRes: any = await this.conn.request(
              "session/set_config_option",
              {
                sessionId: this.nativeSessionId,
                configId: thoughtOpt.id || "thought_level",
                value: chosenEffort,
              },
            );
            if (Array.isArray(tRes?.configOptions)) {
              this.configOptions = tRes.configOptions;
            }
          }
        }
      } catch {
        modelConfigApplied = false;
      }
    }

    if (!modelConfigApplied) {
      await this.conn.request("session/set_model", {
        sessionId: this.nativeSessionId,
        modelId: selection.rawModelId,
      });
    }

    this.currentModelSelection = selection;
  }

  async *startPromptTurn(
    prompt: string | any[],
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    if (signal?.aborted) {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        "Request was aborted before prompt could start",
      );
    }

    if (this._state !== "IDLE") {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        `Cannot start prompt turn in state ${this._state}`,
      );
    }

    // A model that ended its turn instead of asking again never saw these
    // results; hand them over now, labelled, instead of silently dropping them.
    const strandedAll = this.broker.takeStrandedResults();
    // The transcript may already carry a result the caller re-sent; a note about
    // it would be the same fact twice.
    const promptText = Array.isArray(prompt)
      ? prompt.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n")
      : String(prompt ?? "");
    const stranded = strandedAll.filter((entry) => !promptText.includes(entry.callId));
    if (stranded.length > 0) {
      const lines = stranded.map((entry) => {
        const text = entry.result.content
          .map((part: any) => (part.type === "text" ? String(part.text) : `[${part.mimeType} image]`))
          .join("\n");
        return `- ${entry.callId} (${entry.name})${entry.result.isError ? " [error]" : ""}: ${text}`;
      });
      const note = [
        "[bridge] A previous turn ended before these tool results were retrieved. They are given again; do not repeat the calls that produced them.",
        ...lines,
      ].join("\n").slice(0, 16 * 1024);
      prompt = Array.isArray(prompt)
        ? [{ type: "text", text: note }, ...prompt]
        : `${note}\n\n${prompt}`;
    }

    this.broker.openTurnWindow();
    this.setState("GENERATING");
    this.markTurnDiagnosticsStart();
    this.armTurnIdleWatchdog();
    const queue = this.createTurnQueue();

    const seq = this.turn.nextPromptEpoch();

    const promptPromise = this.conn.request(
      "session/prompt",
      {
        sessionId: this.nativeSessionId,
        prompt,
      },
      // A backstop only: the progress watchdog above retires a silent turn in
      // ten minutes, and this bounds a turn that keeps talking forever.
      TURN_TOOL_IDLE_BUDGET_MS,
    );
    this.turn.pendingPrompt = promptPromise;

    promptPromise
      .then((result) => {
        this.handlePromptSuccess(result, seq);
      })
      .catch((err) => {
        this.handlePromptError(err, seq);
      });

    yield* this.drainTurnQueue(queue, signal);
  }

  private handlePromptSuccess(result: any, seq?: number): void {
    this.stopTurnIdleWatchdog();
    if (this.turn.isSuppressedOrStale(seq)) {
      // A cancelled steer turn still spent tokens; bank them so the next
      // reported turn carries them exactly once.
      this.usage.bankSuppressedPromptTurn(
        this.account,
        this.nativeSessionId,
        result?.usage,
      );
      return;
    }

    const terminal = agentTerminalCore(this.turn.heldText);
    if (terminal !== null && this.terminalNoticeIsEvidence(this.turn.heldText)) {
      // The notice's own words are this turn's evidence: `agy` writes it instead
      // of an answer, and each wording is a different failure.
      const errorEvent = this.diagnoseTerminationError(this.turn.heldText);
      this.turn.heldText = "";
      this.turn.finishWith(errorEvent);
      this.setState("IDLE");
      this.turn.pendingPrompt = null;
      return;
    }

    // A notice fragment held back for the next chunk belongs to the answer when
    // the stream ends here, so it is flushed with the rest of the held text.
    this.turn.heldText = this.turn.heldText + this.turn.flushRetryNoticeHold();

    // Answered for real: whatever the account said earlier is over (an appeal can
    // restore it), so the fast-fail record no longer applies. Later than the top of
    // this method on purpose — a cancelled turn returns above without answering,
    // and a terminal notice returns its own verdict, which may be the same block.
    clearPolicyBlock(this.account.accountRef);

    if (this.turn.heldText) {
      this.turn.pushEvent({ type: "text_delta", text: this.turn.heldText });
      this.turn.heldText = "";
    }

    if (result?.stopReason === "refusal") {
      const diag = this.diagnoseTerminationError();
      // Anything the diagnosis recognized, except the generic 500 that stands for
      // "no idea": a refusal with a real cause is that cause (403, 404, 402, 503).
      if (diag.status !== 500) {
        this.turn.finishWith(diag);
        this.setState("IDLE");
        this.turn.pendingPrompt = null;
        return;
      }
    }

    // The prompt result states the turn's exact usage; the step rows are only a
    // fallback for a turn that reported none (a refusal, an empty answer).
    const acpUsage = usageFromAcpPromptResult(result?.usage);
    const promptUsage: TokenUsageSummary = acpUsage
      ? this.usage.settlePromptTurnFromAcp(
          this.account,
          this.nativeSessionId,
          acpUsage,
        )
      : this.usage.settlePromptTurn(
          this.account,
          this.nativeSessionId,
          result?.usage,
        );

    if (this._state === "GENERATING") {
      this.broker.markHttpTurnClosed();

      if (this.options.exposeThinking !== false) {
        const thinking = this.turn.consumeThinkingForSignature();
        if (thinking.length > 0) {
          // A UUID-shaped value, the shape Magpie's preventive filter drops before
          // a Claude route (`deepseekSignature`): the client keeps the block, and
          // no real Anthropic endpoint ever sees a signature it did not issue.
          this.turn.pushEvent({
            type: "thinking_signature",
            signature: thinkingSignatureFor(this.sessionId, thinking),
          });
        }
      } else {
        this.turn.resetThinking();
      }

      const usage: TokenUsageSummary =
        this.usage.drainWithUnreported(promptUsage);

      let stopReason: TurnStopReason = "end_turn";
      if (result?.stopReason === "refusal") {
        stopReason = "refusal";
      } else if (result?.stopReason === "max_tokens") {
        stopReason = "max_tokens";
      } else if (result?.stopReason === "stop_sequence") {
        stopReason = "stop_sequence";
      }

      if (this.turn.queueOpen && result?.stopReason !== "cancelled") {
        this.turn.finishWith({
          type: "finish",
          stopReason,
          usage,
        });
      }

      this.setState("IDLE");
    } else {
      this.broker.markHttpTurnClosed();
      this.usage.bankUnreported(promptUsage);
    }
    this.turn.pendingPrompt = null;
  }

  private handlePromptError(err: any, seq?: number): void {
    this.stopTurnIdleWatchdog();
    if (this.turn.isSuppressedOrStale(seq)) {
      return;
    }
    this.broker.markHttpTurnClosed();
    if (this._state === "GENERATING") {
      this.turn.finishWith(this.diagnoseTerminationError(err));
      this.setState("IDLE");
    }
    this.turn.pendingPrompt = null;
  }

  private async handleClientAbort(): Promise<void> {
    if (this._state !== "GENERATING") {
      return;
    }

    try {
      this.conn.notify("session/cancel", {
        sessionId: this.nativeSessionId,
      });
      this.broker.cancelAll("Client aborted request");
    } catch {}

    const settled = await this.settleOrTimeout(this.turn.pendingPrompt, 1500);

    this.turn.closeQueue();

    if (!settled) {
      await this.close("cancel_timeout");
    } else if (this._state === "GENERATING") {
      this.setState("IDLE");
    }
  }

  /**
   * Waits for `promise` to settle — fulfilment and rejection both count — or
   * for `timeoutMs` to elapse. Resolves `true` when it settled and `false` on
   * timeout; a missing promise counts as already settled.
   */
  private async settleOrTimeout(
    promise: Promise<unknown> | null | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!promise) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Drains one turn's event queue, wiring the caller's abort signal to
   * `handleClientAbort`, and cancelling an abandoned turn even when the
   * consumer stops reading early (`for await ... break` / `return`).
   */
  private async *drainTurnQueue(
    queue: AsyncEventQueue<TurnStreamEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    let abortHandler: (() => void) | null = null;
    if (signal) {
      abortHandler = () => {
        if (this._state === "GENERATING") {
          void this.handleClientAbort();
        }
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    let completedTurn = false;
    try {
      for await (const event of queue) {
        if (event.type === "finish" || event.type === "error") {
          completedTurn = true;
        }
        yield event;
      }
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (!completedTurn && this.state === "GENERATING") {
        await this.handleClientAbort();
      }
    }
  }

  async *continueWithToolResults(
    toolResults: ToolResultDelivery[],
    steeringPromptParts: NormalizedContentPart[],
    signal?: AbortSignal,
    modelSelection?: ModelSelection,
  ): AsyncGenerator<TurnStreamEvent> {
    if (signal?.aborted) {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        "Request was aborted before tool continuation could start",
      );
    }

    if (this._state !== "AWAITING_TOOL_RESULTS") {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        `Cannot continue tool results in state ${this._state}`,
      );
    }

    // 1. Up-front check: Ensure all currently exposed pending IDs are covered
    const exposedIds = this.broker.getExposedPendingIds();
    const providedIds = new Set(toolResults.map((r) => r.toolUseId));
    const missing = exposedIds.filter((id) => !providedIds.has(id));
    if (missing.length > 0) {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        `Missing tool_result for pending tool_use_id(s): ${missing.join(", ")}`,
      );
    }

    // 2. Deliver tool results
    this.noteTurnProgress();
    const delivery = this.broker.deliverToolResults(toolResults);

    if (!delivery.allPendingResolved) {
      if (delivery.newlyExposedCalls.length > 0) {
        if (steeringPromptParts.length > 0) {
          this.broker.cancelAll("Skipped due to user steering message");
        } else {
          for (const call of delivery.newlyExposedCalls) {
            this.turn.markDelivered();
            yield {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            };
          }
          yield {
            type: "finish",
            stopReason: "tool_use",
            usage: emptyUsage(),
          };
          // Remain in AWAITING_TOOL_RESULTS
          return;
        }
      }

      if (steeringPromptParts.length === 0 && delivery.remainingExposedIds.length > 0) {
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          `Missing tool_result for pending tool_use_id(s): ${delivery.remainingExposedIds.join(", ")}`,
        );
      }
    }

    if (steeringPromptParts.length > 0 && this.broker.hasPendingWork()) {
      this.broker.cancelAll("Skipped due to user steering message");
    }

    // 3. All pending resolved:
    // Case A: No steering prompt parts
    if (steeringPromptParts.length === 0) {
      if (!this.turn.pendingPrompt) {
        if (!this.conn || this.isClosed) {
          throw new SteerReplayNeededError(
            "Worker closed while awaiting tool results",
          );
        }
        const resultTexts = toolResults.map((tr) => {
          const contentText = tr.content
            .filter((c) => c.type === "text")
            .map((c) => (c as any).text)
            .join("\n");
          return `[Tool Result: ${tr.toolUseId}${tr.isError ? " (error)" : ""}]:\n${contentText}\n[end of tool result]`;
        });
        const promptText =
          resultTexts.join("\n\n") +
          "\n\nContinue based on the completed tool result(s) above.";
        const lateContinuationParts: NormalizedContentPart[] = [
          { type: "text", text: promptText },
        ];
        for (const tr of toolResults) {
          for (const item of tr.content) {
            if (item.type === "image") {
              lateContinuationParts.push({
                type: "image",
                data: item.data,
                mimeType: item.mediaType,
              } as any);
            }
          }
        }
        this.setState("IDLE");
        yield* this.startPromptTurn(lateContinuationParts, signal);
        return;
      }

      this.setState("GENERATING");
      const queue = this.createTurnQueue();
      yield* this.drainTurnQueue(queue, signal);
      return;
    }

    // Case B: Steering prompt parts present
    this.turn.suppressingSteerCancel = true;
    this.turn.nextPromptEpoch();

    try {
      await this.waitForActiveToolCallsCommit(
        this.steerToolCommitTimeoutMs ?? 5_000,
      );
    } catch (err) {
      // The barrier already closed the worker; continuing would talk to a dead
      // connection. Surface a replay request so the coordinator cold-replays.
      this.turn.suppressingSteerCancel = false;
      throw new SteerReplayNeededError(
        err instanceof Error
          ? err.message
          : "Timed out waiting for active tool calls to commit before steering",
      );
    }

    const oldPromptPromise = this.turn.pendingPrompt;
    this.turn.pendingPrompt = null;

    if (this.conn) {
      try {
        this.conn.notify("session/cancel", {
          sessionId: this.nativeSessionId,
        });
      } catch {}
    }

    const settled = await this.settleOrTimeout(
      oldPromptPromise,
      this.steerCancelTimeoutMs ?? 5_000,
    );

    if (!settled) {
      await this.close("steer_cancel_unsettled");
      throw new SteerReplayNeededError(
        "Prompt cancel timed out during steer; worker retired",
      );
    }

    this.turn.suppressingSteerCancel = false;
    this.setState("IDLE");

    if (modelSelection) {
      await this.applyModelSelection(modelSelection, signal);
    }

    const acpSteeringParts = steeringPromptParts.map((p: any) => {
      if (p.type === "image") {
        return {
          type: "image",
          mimeType: p.mediaType || p.mimeType,
          data: p.data,
        };
      }
      return p;
    });

    yield* this.startPromptTurn(acpSteeringParts, signal);
  }

  private async waitForActiveToolCallsCommit(timeoutMs: number): Promise<void> {
    if (this.activeAcpToolCallIds.size === 0) return;

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        if (this.activeAcpToolCallIds.size === 0) {
          cleanup();
          resolve();
        }
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error("commit_timeout"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.toolCommitWaiters.delete(check);
      };

      this.toolCommitWaiters.add(check);
      timer = setTimeout(onTimeout, timeoutMs);
    }).catch(async () => {
      await this.close("tool_commit_barrier_timeout");
      throw new BridgeHttpError(
        502,
        "api_error",
        "Tool execution commit barrier timed out",
      );
    });
  }

  closeSync(reason = "process_exit"): void {
    if (this.isClosed) return;
    this.stopTurnIdleWatchdog();
    this.isClosed = true;
    liveWorkersForExitCleanup.delete(this);
    this.setState("CLOSED");

    this.unregisterMcp?.();
    this.unregisterMcp = undefined;

    if (this.unsubscribeSessionUpdate) {
      this.unsubscribeSessionUpdate();
      this.unsubscribeSessionUpdate = undefined;
    }

    this.turn.failQueue(
      new BridgeHttpError(502, "api_error", `Worker closed: ${reason}`),
    );

    for (const waiter of this.toolCommitWaiters) {
      waiter();
    }
    this.toolCommitWaiters.clear();

    try {
      this.broker?.cancelAll(reason);
    } catch {}

    try {
      this.conn?.close();
    } catch {}

    try {
      if (this.child && this.child.exitCode === null) {
        killProcessTree(this.child, "SIGKILL");
      }
    } catch {}

    try {
      if (
        this.ownsWorkspaceDir &&
        this.workspaceDir &&
        fs.existsSync(this.workspaceDir)
      ) {
        fs.rmSync(this.workspaceDir, { recursive: true, force: true });
      }
    } catch {}
  }

  async close(reason = "normal"): Promise<void> {
    this.closeSync(reason);
  }
}
