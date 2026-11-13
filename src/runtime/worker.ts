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
import {
  turnsAway,
  refusalHint,
  cloakSystemPrompt,
} from "../protocol/cloak";
import {
  settleStepUsage,
  readConversationStepUsages,
} from "../usage/step-usage";
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
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  toolChoice?: ToolChoiceSpec;
  workspaceDir?: string;
  steerCancelTimeoutMs?: number;
  onStateChange?: (
    worker: AgySessionWorker,
    oldState: WorkerState,
    newState: WorkerState,
  ) => void;
  onEvict?: () => void;
}

const AGENT_ERROR_MARKER = "\n⚠ Agent execution terminated due to error.\n";
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

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<{
    resolve: (item: IteratorResult<T>) => void;
    reject: (err: any) => void;
  }> = [];
  private closed = false;
  private error: any = null;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  errorAndClose(err: any): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined as any, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift()!;
      return { value, done: false };
    }
    if (this.closed) {
      if (this.error) {
        throw this.error;
      }
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
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

function buildWorkDirDisambiguationNote(callerWorkDir: string): string {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; where an environment given elsewhere in this conversation differs, go by the caller's instructions without checking.`;
}

export class AgySessionWorker {
  readonly account: AccountDescriptor;
  readonly sessionId: string;
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

  readonly activeAcpToolCallIds = new Set<string>();
  pinned: boolean = false;
  steerCancelTimeoutMs?: number;

  private promptSeq = 0;
  private activePromptSeq = 0;
  private suppressingSteerCancel = false;
  private activeTurnQueue: AsyncEventQueue<TurnStreamEvent> | null = null;
  private pendingPromptPromise: Promise<any> | null = null;
  private currentThinkingAccumulator: string = "";
  private unsubscribeSessionUpdate?: () => void;
  private unregisterMcp?: () => void;
  private isClosed = false;
  private readonly toolCommitWaiters = new Set<() => void>();
  private unreportedUsage: TokenUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  private turnLogOffset: number = 0;
  private heldText: string = "";
  private promptStepCount: number = 1;
  private lastReportedStepIdx: number = -1;
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

  setExposeThinking(enabled: boolean): void {
    this.options.exposeThinking = enabled;
    if (!enabled) {
      this.currentThinkingAccumulator = "";
    }
  }

  private setState(newState: WorkerState): void {
    if (this._state === newState) return;
    if (this._state === "CLOSED") return;
    const oldState = this._state;
    this._state = newState;
    this.lastActivityAt = Date.now();
    this.options.onStateChange?.(this, oldState, newState);
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
        "Use only the provided MCP tools when tools are needed. Never output raw XML/JSON tool-call markup as text.",
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
      const args = [
        "acp",
        "--agent",
        "magpie-bridge",
        "--stdio",
        "--process-per-session",
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
      let effectiveSystem = "";
      let systemWithWorkDir = this.options.systemPrompt ?? "";
      if (this.options.workDir && !/[\r\n\0]/.test(this.options.workDir)) {
        const dirNote = buildWorkDirDisambiguationNote(this.options.workDir);
        systemWithWorkDir = systemWithWorkDir.trim()
          ? `${systemWithWorkDir}\n\n${dirNote}`
          : dirNote;
      }
      effectiveSystem = cloakSystemPrompt(
        systemWithWorkDir,
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
          if (this.appendSystemSupported && effectiveSystem) {
            resumeParams._meta = {
              antigravity: {
                systemPrompt: {
                  append: effectiveSystem,
                },
              },
            };
          }
          sessionRes = await this.conn.request("session/resume", resumeParams);
          this.resumedFromShelf = true;
          this.nativeSessionId =
            sessionRes?.sessionId || this.options.resumeSessionId;
          const priorSteps = readConversationStepUsages(
            this.account,
            this.nativeSessionId,
          );
          if (priorSteps.length > 0) {
            this.lastReportedStepIdx = priorSteps[priorSteps.length - 1]!.idx;
          }
        } catch {
          this.resumedFromShelf = false;
        }
      }

      if (!sessionRes) {
        const newParams: Record<string, unknown> = {
          cwd: this.workspaceDir,
          mcpServers: [{ name: "magpie", type: "http", url: this.mcpUrl }],
        };

        if (this.appendSystemSupported && effectiveSystem) {
          newParams._meta = {
            antigravity: {
              systemPrompt: {
                append: effectiveSystem,
              },
            },
          };
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
    if (this.suppressingSteerCancel) {
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

      let text = this.heldText + chunk;
      this.heldText = "";

      const marker = text.lastIndexOf(AGENT_ERROR_CORE);
      if (
        marker >= 0 &&
        !text.slice(marker + AGENT_ERROR_CORE.length).trim()
      ) {
        const start = text[marker - 1] === "\n" ? marker - 1 : marker;
        this.heldText = text.slice(start);
        text = text.slice(0, start);
        if (this.activeTurnQueue && text) {
          this.activeTurnQueue.push({ type: "text_delta", text });
        }
        return;
      }

      for (
        let keep = Math.min(text.length, AGENT_ERROR_MARKER.length - 1);
        keep > 0;
        keep--
      ) {
        if (AGENT_ERROR_MARKER.startsWith(text.slice(-keep))) {
          this.heldText = text.slice(-keep);
          text = text.slice(0, -keep);
          break;
        }
      }

      if (this.activeTurnQueue && text) {
        this.activeTurnQueue.push({ type: "text_delta", text });
      }
    } else if (updateType === "agent_thought_chunk") {
      const thinking = update.content?.text ?? update.text ?? "";
      if (
        this.options.exposeThinking !== false &&
        this.activeTurnQueue &&
        thinking
      ) {
        this.currentThinkingAccumulator += thinking;
        this.activeTurnQueue.push({ type: "thinking_delta", thinking });
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

  private diagnoseTerminationError(rawErr?: unknown): TurnStreamEvent {
    let logContent = "";
    try {
      const logPath = path.join(this.workspaceDir, "agy-acp.log");
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        const length = stat.size - this.turnLogOffset;
        if (length > 0) {
          const fd = fs.openSync(logPath, "r");
          try {
            const buf = Buffer.alloc(length);
            fs.readSync(fd, buf, 0, length, this.turnLogOffset);
            logContent = buf.toString("utf-8");
          } finally {
            try {
              fs.closeSync(fd);
            } catch {}
          }
        }
      }
    } catch {}

    const rawErrMsg =
      rawErr instanceof Error
        ? rawErr.message
        : rawErr !== undefined && rawErr !== null
          ? String(rawErr)
          : "";
    const redactedRawErr = redactSecrets(rawErrMsg);

    const stderrTail = this.conn?.getStderrTail() ?? "";
    const combined = `${logContent}\n${stderrTail}\n${redactedRawErr}`;

    if (
      /please sign in|not (?:logged|signed) in|authentication expired|login required|unauthenticated/i.test(
        combined,
      )
    ) {
      return {
        type: "error",
        status: 401,
        errorType: "authentication_error",
        message: "Antigravity CLI authentication expired. Please sign in again.",
        signInExpired: true,
      };
    }

    if (
      /429|RESOURCE_EXHAUSTED|exhausted your quota|quota/i.test(combined)
    ) {
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
    }
    if (/invalid_request|bad request|invalid argument/i.test(combined)) {
      return {
        type: "error",
        status: 400,
        errorType: "invalid_request_error",
        message: "Invalid request to agent",
      };
    }
    const fallbackMsg = redactedRawErr
      ? `Agent execution terminated due to error: ${redactedRawErr}`
      : "Agent execution terminated due to error";
    return {
      type: "error",
      status: 500,
      errorType: "api_error",
      message: fallbackMsg,
    };
  }

  private handleFatalToolLoop(reason: string): void {
    if (this.activeTurnQueue) {
      this.activeTurnQueue.push({
        type: "error",
        status: 500,
        errorType: "api_error",
        message: `Fatal tool loop detected: ${reason}`,
      });
      const q = this.activeTurnQueue;
      this.activeTurnQueue = null;
      q.close();
    }
    void this.close("fatal_tool_loop");
  }

  private handleBatchReady(calls: ExposedToolCall[]): void {
    if (!this.activeTurnQueue) return;

    // 1. If thinking accumulated, yield thinking signature
    if (
      this.options.exposeThinking !== false &&
      this.currentThinkingAccumulator.length > 0
    ) {
      const signature = createSyntheticThinkingSignature(
        this.sessionId,
        this.currentThinkingAccumulator,
      );
      this.activeTurnQueue.push({ type: "thinking_signature", signature });
    }
    this.currentThinkingAccumulator = "";

    // 2. Yield tool_use events
    for (const call of calls) {
      this.activeTurnQueue.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }

    // 3. Transition worker state: GENERATING -> AWAITING_TOOL_RESULTS
    this.promptStepCount++;
    this.setState("AWAITING_TOOL_RESULTS");

    // 4. Read exact per-step usage from agy's SQLite gen_metadata if already flushed
    let toolStepUsage: TokenUsageSummary = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const dbSteps = readConversationStepUsages(
      this.account,
      this.nativeSessionId,
    ).filter((s) => s.idx > this.lastReportedStepIdx);
    if (dbSteps.length > 0) {
      const latest = dbSteps[dbSteps.length - 1]!;
      this.lastReportedStepIdx = latest.idx;
      toolStepUsage = settleStepUsage(undefined, 1, [latest]);
    }

    this.activeTurnQueue.push({
      type: "finish",
      stopReason: "tool_use",
      usage: toolStepUsage,
    });

    // 5. Close the active HTTP turn queue WITHOUT cancelling session/prompt!
    const q = this.activeTurnQueue;
    this.activeTurnQueue = null;
    q.close();
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
    this.currentThinkingAccumulator = "";
    this.heldText = "";
    const logPath = path.join(this.workspaceDir, "agy-acp.log");
    try {
      this.turnLogOffset = fs.statSync(logPath).size;
    } catch {
      this.turnLogOffset = 0;
    }
    const queue = new AsyncEventQueue<TurnStreamEvent>();
    this.activeTurnQueue = queue;

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

    const seq = ++this.promptSeq;
    this.activePromptSeq = seq;

    this.pendingPromptPromise = this.conn.request(
      "session/prompt",
      {
        sessionId: this.nativeSessionId,
        prompt,
      },
      30 * 60 * 1000, // 30-minute generation watchdog (matches claude_subscription.go)
    );

    this.pendingPromptPromise
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
    if (
      this.suppressingSteerCancel ||
      (seq !== undefined && seq !== this.activePromptSeq)
    ) {
      try {
        const stepUsages = readConversationStepUsages(
          this.account,
          this.nativeSessionId,
        );
        const settledUsage = settleStepUsage(
          result?.usage,
          this.promptStepCount,
          stepUsages.length > 0 ? stepUsages : undefined,
        );
        this.unreportedUsage.inputTokens += settledUsage.inputTokens;
        this.unreportedUsage.outputTokens += settledUsage.outputTokens;
        this.unreportedUsage.cacheReadInputTokens +=
          settledUsage.cacheReadInputTokens;
        this.unreportedUsage.cacheCreationInputTokens +=
          settledUsage.cacheCreationInputTokens;
      } catch {}
      return;
    }

    if (this.heldText.includes(AGENT_ERROR_CORE)) {
      this.heldText = "";
      const errorEvent = this.diagnoseTerminationError();
      if (this.activeTurnQueue) {
        this.activeTurnQueue.push(errorEvent);
        const q = this.activeTurnQueue;
        this.activeTurnQueue = null;
        q.close();
      }
      this.setState("IDLE");
      this.pendingPromptPromise = null;
      return;
    }

    if (this.heldText && this.activeTurnQueue) {
      this.activeTurnQueue.push({ type: "text_delta", text: this.heldText });
      this.heldText = "";
    }

    if (result?.stopReason === "refusal") {
      const diag = this.diagnoseTerminationError();
      if (
        diag.type === "error" &&
        (diag.status === 400 || diag.status === 401 || diag.status === 429)
      ) {
        if (this.activeTurnQueue) {
          this.activeTurnQueue.push(diag);
          const q = this.activeTurnQueue;
          this.activeTurnQueue = null;
          q.close();
        }
        this.setState("IDLE");
        this.pendingPromptPromise = null;
        return;
      }
    }

    const allDbSteps = readConversationStepUsages(
      this.account,
      this.nativeSessionId,
    );
    const unseenDbSteps = allDbSteps.filter(
      (s) => s.idx > this.lastReportedStepIdx,
    );
    if (unseenDbSteps.length > 0) {
      this.lastReportedStepIdx = unseenDbSteps[unseenDbSteps.length - 1]!.idx;
    }
    const settledUsage = settleStepUsage(
      result?.usage,
      this.promptStepCount,
      unseenDbSteps.length > 0 ? unseenDbSteps : undefined,
    );
    this.promptStepCount = 1;

    const promptUsage: TokenUsageSummary = settledUsage;

    if (this._state === "GENERATING") {
      this.broker.markHttpTurnClosed();

      if (
        this.options.exposeThinking !== false &&
        this.currentThinkingAccumulator.length > 0 &&
        this.activeTurnQueue
      ) {
        const signature = createSyntheticThinkingSignature(
          this.sessionId,
          this.currentThinkingAccumulator,
        );
        this.activeTurnQueue.push({ type: "thinking_signature", signature });
      }
      this.currentThinkingAccumulator = "";

      const usage: TokenUsageSummary = {
        inputTokens: promptUsage.inputTokens + this.unreportedUsage.inputTokens,
        outputTokens: promptUsage.outputTokens + this.unreportedUsage.outputTokens,
        cacheReadInputTokens:
          promptUsage.cacheReadInputTokens +
          this.unreportedUsage.cacheReadInputTokens,
        cacheCreationInputTokens:
          promptUsage.cacheCreationInputTokens +
          this.unreportedUsage.cacheCreationInputTokens,
      };
      this.unreportedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      let stopReason: TurnStopReason = "end_turn";
      if (result?.stopReason === "refusal") {
        stopReason = "refusal";
      } else if (result?.stopReason === "max_tokens") {
        stopReason = "max_tokens";
      } else if (result?.stopReason === "stop_sequence") {
        stopReason = "stop_sequence";
      }

      if (this.activeTurnQueue && result?.stopReason !== "cancelled") {
        this.activeTurnQueue.push({
          type: "finish",
          stopReason,
          usage,
        });
        const q = this.activeTurnQueue;
        this.activeTurnQueue = null;
        q.close();
      }

      this.setState("IDLE");
    } else {
      this.broker.markHttpTurnClosed();
      this.unreportedUsage.inputTokens += promptUsage.inputTokens;
      this.unreportedUsage.outputTokens += promptUsage.outputTokens;
      this.unreportedUsage.cacheReadInputTokens +=
        promptUsage.cacheReadInputTokens;
      this.unreportedUsage.cacheCreationInputTokens +=
        promptUsage.cacheCreationInputTokens;
    }
    this.pendingPromptPromise = null;
  }

  private handlePromptError(err: any, seq?: number): void {
    if (
      this.suppressingSteerCancel ||
      (seq !== undefined && seq !== this.activePromptSeq)
    ) {
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

      if (this.activeTurnQueue) {
        this.activeTurnQueue.push(eventToSend);
        const q = this.activeTurnQueue;
        this.activeTurnQueue = null;
        q.close();
      }
      this.setState("IDLE");
    }
    this.pendingPromptPromise = null;
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
    if (this.pendingPromptPromise) {
      try {
        await Promise.race([
          this.pendingPromptPromise.then(
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

    if (this.activeTurnQueue) {
      const q = this.activeTurnQueue;
      this.activeTurnQueue = null;
      q.close();
    }

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
      if (!this.pendingPromptPromise) {
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
      const queue = new AsyncEventQueue<TurnStreamEvent>();
      this.activeTurnQueue = queue;

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
    this.suppressingSteerCancel = true;
    this.activePromptSeq = ++this.promptSeq;

    try {
      await this.waitForActiveToolCallsCommit(5_000);
    } catch {}

    const oldPromptPromise = this.pendingPromptPromise;
    this.pendingPromptPromise = null;

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

    this.suppressingSteerCancel = false;
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

    if (this.activeTurnQueue) {
      this.activeTurnQueue.errorAndClose(
        new BridgeHttpError(502, "api_error", `Worker closed: ${reason}`),
      );
      this.activeTurnQueue = null;
    }

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
