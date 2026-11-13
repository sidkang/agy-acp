import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type EffortLevel,
  type NormalizedAnthropicRequest,
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
  CONTEXT_BUDGET_FAILURE_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  TurnLogWatch,
  classifyAgentFailure,
  extractErrorEvidence,
  stderrDelta,
} from "./diagnostics";
import {
  turnsAway,
  refusalHint,
  cloakSystemPrompt,
} from "../protocol/cloak";
import { settleStepUsage } from "../usage/step-usage";
import { StepUsageTracker } from "../usage/tracker";
import {
  spawnAgy,
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
import { AsyncEventQueue, TurnContext } from "./turn-context";

export {
  AsyncEventQueue,
  DEFAULT_MAX_TURN_QUEUE_BYTES,
  type AsyncEventQueueOptions,
} from "./turn-context";

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
  onEvict?: () => void;
}

const AGENT_ERROR_MARKER = "\n⚠ Agent execution terminated due to error.\n";

/** `ps`-based RSS sampling is throttled to this window on non-Linux hosts. */
const RSS_SAMPLE_COOLDOWN_MS = 10_000;
const AGENT_ERROR_CORE = AGENT_ERROR_MARKER.trim();

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

export function createSyntheticThinkingSignature(
  sessionId: string,
  thinkingText: string,
): string {
  const hmac = crypto
    .createHmac("sha256", sessionId)
    .update(thinkingText)
    .digest("hex");
  return `agy1.${hmac}`;
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
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
        if (!isProcessAlive(ownerPid)) {
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
  cloak = true,
): string {
  let systemWithWorkDir = systemPrompt ?? "";
  if (workDir && !/[\r\n\0]/.test(workDir)) {
    const dirNote = buildWorkDirDisambiguationNote(workDir);
    systemWithWorkDir = systemWithWorkDir.trim()
      ? `${systemWithWorkDir}\n\n${dirNote}`
      : dirNote;
  }
  return cloakSystemPrompt(systemWithWorkDir, cloak);
}

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
  readonly onEvict?: () => void;
  private readonly mcpServer: LoopbackMcpServer;
  private readonly options: WorkerOptions;

  private _state: WorkerState = "STARTING";
  lastActivityAt: number = Date.now();

  broker!: SessionToolBroker;
  private child!: ChildProcessWithoutNullStreams;
  private conn!: AcpConnection;
  private mcpUrl!: string;
  private mcpToken?: string;

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
  private manualPinned: boolean = false;
  private capacityListener?: () => void;
  private lastRssSampleAt: number = 0;
  private lastRssBytes: number = 0;

  /**
   * A worker is held by every owner that currently needs it: the coordinator's
   * turn (a `pin()` lease) and the admission and side-request paths that set
   * `pinned` directly. It is evictable only when none of them holds it.
   */
  get pinned(): boolean {
    return this.pinLeases > 0 || this.manualPinned;
  }

  /**
   * Unpinning makes this worker evictable, so it is a capacity event: waiters
   * parked in the scheduler must be woken instead of polling.
   */
  set pinned(value: boolean) {
    const wasPinned = this.pinned;
    this.manualPinned = Boolean(value);
    if (wasPinned && !this.pinned) {
      this.notifyCapacityChange();
    }
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
    this.onEvict = this.options.onEvict;
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

  async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      await this.close("aborted_startup");
      throw new BridgeHttpError(
        499,
        "invalid_request_error",
        "Request aborted during startup",
      );
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

      const minimalAgent = Boolean(this.options.minimalAgent);
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
      if ((reg as any).token) {
        this.mcpToken = (reg as any).token;
      }

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
        await this.close("aborted_startup");
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request aborted during startup",
        );
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
        const stderr = this.conn.getStderrTail();
        const combined = `${err?.message || ""}\n${stderr}`;
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

      if (signal?.aborted) {
        await this.close("aborted_startup");
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request aborted during startup",
        );
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

      // Cloak system prompt
      const effectiveSystem = buildEffectiveSystemText(
        this.options.systemPrompt,
        this.options.workDir,
        this.options.cloakPrompts !== false,
      );
      this.effectiveSystemPrompt = effectiveSystem;

      // 6. ACP session/resume or session/new
      let sessionRes: any = null;
      if (this.options.resumeSessionId && this.resumeSupported) {
        try {
          const resumeParams: Record<string, unknown> = {
            sessionId: this.options.resumeSessionId,
            cwd: this.workspaceDir,
            mcpServers: [{ name: "magpie", type: "http", url: this.mcpUrl }],
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
          mcpServers: [{ name: "magpie", type: "http", url: this.mcpUrl }],
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
          const stderr = this.conn.getStderrTail();
          const combined = `${err?.message || ""}\n${stderr}`;
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
      }

      if (Array.isArray((sessionRes as any)?.configOptions)) {
        this.configOptions = (sessionRes as any).configOptions;
      }

      if (signal?.aborted) {
        await this.close("aborted_startup");
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request aborted during startup",
        );
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
    if (this.turn.suppressingSteerCancel) {
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

      let text = this.turn.heldText + chunk;
      this.turn.heldText = "";

      const marker = text.lastIndexOf(AGENT_ERROR_CORE);
      if (
        marker >= 0 &&
        !text.slice(marker + AGENT_ERROR_CORE.length).trim()
      ) {
        const start = text[marker - 1] === "\n" ? marker - 1 : marker;
        this.turn.heldText = text.slice(start);
        text = text.slice(0, start);
        if (text) this.turn.pushEvent({ type: "text_delta", text });
        return;
      }

      for (
        let keep = Math.min(text.length, AGENT_ERROR_MARKER.length - 1);
        keep > 0;
        keep--
      ) {
        if (AGENT_ERROR_MARKER.startsWith(text.slice(-keep))) {
          this.turn.heldText = text.slice(-keep);
          text = text.slice(0, -keep);
          break;
        }
      }

      if (text) this.turn.pushEvent({ type: "text_delta", text });
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

  private diagnoseTerminationError(rawErr?: unknown): TurnStreamEvent {
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
    switch (classifyAgentFailure(evidence, redactedRawErr)) {
      case "context_budget":
        // `agy` refused to serialize the trajectory (`maxMessageTokens must be
        // positive, got 0`). The public text is fixed and neutral: the raw line
        // is not actionable, and naming quotas would trip Magpie's quota-word
        // detector and rest a healthy account.
        return {
          type: "error",
          status: 500,
          errorType: "api_error",
          message: CONTEXT_BUDGET_FAILURE_MESSAGE,
        };
      case "auth":
        return {
          type: "error",
          status: 401,
          errorType: "authentication_error",
          message: "Antigravity CLI authentication expired. Please sign in again.",
          signInExpired: true,
        };
      case "quota":
        if (turnsAway(this.systemPrompt) && !this.options.cloakPrompts) {
          return {
            type: "error",
            status: 400,
            errorType: "invalid_request_error",
            message: refusalHint(this.systemPrompt),
          };
        }
        return {
          type: "error",
          status: 429,
          errorType: "rate_limit_error",
          message: "Account quota exhausted",
        };
      case "invalid_request":
        return {
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          message: "Invalid request to agent",
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
        const signature = createSyntheticThinkingSignature(
          this.sessionId,
          thinking,
        );
        q.push({ type: "thinking_signature", signature });
      }
    } else {
      this.turn.resetThinking();
    }

    // 2. Yield tool_use events
    for (const call of calls) {
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
    let toolStepUsage: TokenUsageSummary = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
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
      throw new BridgeHttpError(
        499,
        "invalid_request_error",
        "Request aborted during startup",
      );
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

    this.broker.openTurnWindow();
    this.setState("GENERATING");
    this.markTurnDiagnosticsStart();
    const queue = this.createTurnQueue();

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

    const seq = this.turn.nextPromptEpoch();

    const promptPromise = this.conn.request(
      "session/prompt",
      {
        sessionId: this.nativeSessionId,
        prompt,
      },
      30 * 60 * 1000, // 30-minute generation watchdog (matches claude_subscription.go)
    );
    this.turn.pendingPrompt = promptPromise;

    promptPromise
      .then((result) => {
        this.handlePromptSuccess(result, seq);
      })
      .catch((err) => {
        this.handlePromptError(err, seq);
      });

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

  private handlePromptSuccess(result: any, seq?: number): void {
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

    if (this.turn.heldText.includes(AGENT_ERROR_CORE)) {
      this.turn.heldText = "";
      const errorEvent = this.diagnoseTerminationError();
      this.turn.finishWith(errorEvent);
      this.setState("IDLE");
      this.turn.pendingPrompt = null;
      return;
    }

    if (this.turn.heldText) {
      this.turn.pushEvent({ type: "text_delta", text: this.turn.heldText });
      this.turn.heldText = "";
    }

    if (result?.stopReason === "refusal") {
      const diag = this.diagnoseTerminationError();
      if (
        diag.type === "error" &&
        (diag.status === 400 || diag.status === 401 || diag.status === 429)
      ) {
        this.turn.finishWith(diag);
        this.setState("IDLE");
        this.turn.pendingPrompt = null;
        return;
      }
    }

    const promptUsage: TokenUsageSummary = this.usage.settlePromptTurn(
      this.account,
      this.nativeSessionId,
      result?.usage,
    );

    if (this._state === "GENERATING") {
      this.broker.markHttpTurnClosed();

      if (this.options.exposeThinking !== false) {
        const thinking = this.turn.consumeThinkingForSignature();
        if (thinking.length > 0) {
          const signature = createSyntheticThinkingSignature(
            this.sessionId,
            thinking,
          );
          this.turn.pushEvent({ type: "thinking_signature", signature });
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
    if (this.turn.isSuppressedOrStale(seq)) {
      return;
    }
    this.broker.markHttpTurnClosed();
    if (this._state === "GENERATING") {
      const errorEvent = this.diagnoseTerminationError(err);
      const eventToSend: TurnStreamEvent =
        errorEvent.type === "error"
          ? errorEvent
          : {
              type: "error",
              status: 500,
              errorType: "api_error",
              message: redactSecrets(err?.message || "ACP prompt failed"),
            };

      this.turn.finishWith(eventToSend);
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

    let settled = false;
    const promptPromise = this.turn.pendingPrompt;
    if (promptPromise) {
      try {
        await Promise.race([
          promptPromise.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          ),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } catch {}
    } else {
      settled = true;
    }

    this.turn.closeQueue();

    if (!settled) {
      await this.close("cancel_timeout");
    } else if (this._state === "GENERATING") {
      this.setState("IDLE");
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
    const delivery = this.broker.deliverToolResults(toolResults);

    if (!delivery.allPendingResolved) {
      if (delivery.newlyExposedCalls.length > 0) {
        if (steeringPromptParts.length > 0) {
          this.broker.cancelUnexposed("Skipped due to user steering message");
        } else {
          for (const call of delivery.newlyExposedCalls) {
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
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
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
      this.broker.cancelUnexposed("Skipped due to user steering message");
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
      return;
    }

    // Case B: Steering prompt parts present
    this.turn.suppressingSteerCancel = true;
    this.turn.nextPromptEpoch();

    try {
      await this.waitForActiveToolCallsCommit(
        this.steerToolCommitTimeoutMs ??
          this.options.steerToolCommitTimeoutMs ??
          5_000,
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

    let settled = false;
    const cancelTimeoutMs =
      this.steerCancelTimeoutMs ??
      this.options.steerCancelTimeoutMs ??
      5_000;
    if (oldPromptPromise) {
      try {
        await Promise.race([
          oldPromptPromise.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          ),
          new Promise((r) => setTimeout(r, cancelTimeoutMs)),
        ]);
      } catch {}
    } else {
      settled = true;
    }

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
