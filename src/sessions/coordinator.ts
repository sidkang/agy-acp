import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { policyBlockedMessage } from "../accounts/policy-block";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type NormalizedContentPart,
  type ProviderOptionsState,
  type TurnStreamEvent,
} from "../types";
import {
  AgySessionWorker,
  SteerReplayNeededError,
  buildEffectiveSystemText,
  type ModelSelection,
  type WorkerOptions,
} from "../runtime/worker";
import type { GlobalScheduler } from "../runtime/scheduler";
import { DEFAULT_MAX_WORKER_RSS_BYTES } from "../runtime/rss";
import type { LoopbackMcpServer } from "../mcp/http-server";
import { sweepStaleAccountStorage, type SpawnAgyOptions } from "../accounts/env";
import type { ToolResultDelivery } from "../mcp/broker";
import { fitInlineImage, type ImageMediaType } from "../protocol/images";
import {
  buildCommittedMessages,
  getOpeningUserText,
  getToolChoiceReminder,
  isCompactedRequest,
  isToolSetCompatible,
  matchLedgerPrefix,
  normalizeWorkDir,
  subagentIdFromSessionKey,
  systemPromptsMatch,
  type GeneratedToolCall,
  utf8Bytes,
  validateNoOrphanToolResults,
} from "./ledger";
import {
  planColdHistoryRender,
  renderMessagesToPrompt,
  requestHasImages,
  splitPriorAndCurrent,
} from "./prompt-render";
import {
  ShelfStore,
  type ClaimedShelfResume,
  type WorkerParkSnapshot,
} from "./shelf-store";

export interface TurnExecutionOptions {
  spawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  providerOptions?: ProviderOptionsState;
  steerCancelTimeoutMs?: number;
  steerToolCommitTimeoutMs?: number;
  /** Test hook: overrides process-tree RSS sampling for the turn's worker. */
  measureRssBytes?: () => number;
}

export interface SessionCoordinatorOptions {
  scheduler: GlobalScheduler;
  mcpServer: LoopbackMcpServer;
  spawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  providerOptions?: ProviderOptionsState;
  steerCancelTimeoutMs?: number;
  steerToolCommitTimeoutMs?: number;
  /** Post-turn RSS ceiling; `0` disables recycling. */
  maxWorkerRssBytes?: number;
}

/**
 * Resolves the post-turn RSS ceiling: explicit option, then
 * `AGY_BRIDGE_MAX_WORKER_RSS_MB` (megabytes), then the 1 GiB default.
 * `0` disables RSS recycling entirely.
 */
function resolveMaxWorkerRssBytes(explicit?: number): number {
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit >= 0
  ) {
    return explicit;
  }
  const rawMb = process.env.AGY_BRIDGE_MAX_WORKER_RSS_MB?.trim();
  if (rawMb) {
    const mb = Number(rawMb);
    if (Number.isFinite(mb) && mb >= 0) return Math.floor(mb * 1024 * 1024);
  }
  return DEFAULT_MAX_WORKER_RSS_BYTES;
}

const STORAGE_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class SessionCoordinator {
  readonly scheduler: GlobalScheduler;
  readonly mcpServer: LoopbackMcpServer;
  private readonly options?: SessionCoordinatorOptions;
  private readonly defaultSpawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  private readonly providerOptions?: ProviderOptionsState;
  /**
   * Post-turn RSS ceiling for one worker tree. A worker that finishes a clean
   * turn above this limit is parked and closed so the next turn resumes through
   * `session/resume` instead of pinning a gigabyte-scale Go process forever.
   */
  private readonly maxWorkerRssBytes: number;

  /** Warm shelf + zero-plaintext resume index, behind one module (ARCH-1). */
  readonly shelf = new ShelfStore();

  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkers = new Map<string, AgySessionWorker>();
  private lastStorageGcAt = 0;

  constructor(options: SessionCoordinatorOptions) {
    this.options = options;
    this.scheduler = options.scheduler;
    this.mcpServer = options.mcpServer;
    this.defaultSpawnFn = options.spawnFn;
    this.providerOptions = options.providerOptions;
    this.maxWorkerRssBytes = resolveMaxWorkerRssBytes(options.maxWorkerRssBytes);

    // Typed lifecycle hooks instead of overwriting the scheduler's properties:
    // a second coordinator (or a test) can register its own without clobbering
    // this one, and a throwing hook cannot break eviction or reaping.
    this.scheduler.addBeforeEvictIdleHook((worker) => {
      this.parkSession(worker);
    });
    this.scheduler.addReapTickHook((now) => {
      this.pruneParkedSessions(now);
      if (now - this.lastStorageGcAt >= STORAGE_GC_INTERVAL_MS) {
        this.lastStorageGcAt = now;
        this.sweepAccountStorage(now);
      }
    });
  }

  pruneParkedSessions(now = Date.now()): void {
    this.shelf.prune(now);
  }

  sweepAccountStorage(now = Date.now()): void {
    const protectedSessionIds = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      if (worker.nativeSessionId) protectedSessionIds.add(worker.nativeSessionId);
      if (worker.sessionId) protectedSessionIds.add(worker.sessionId);
    }
    for (const id of this.shelf.collectProtectedNativeSessionIds(now)) {
      protectedSessionIds.add(id);
    }
    try {
      sweepStaleAccountStorage({ now, protectedSessionIds });
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Shelf plumbing
  // ---------------------------------------------------------------------------

  /** The key this worker is registered under, or would be. */
  private sessionKeyForWorker(worker: AgySessionWorker): string {
    for (const [key, w] of this.activeWorkers) {
      if (w === worker) return key;
    }
    return `${worker.account.slotKey}::${worker.account.accountRef}::${worker.sessionId}`;
  }

  private snapshotForWorker(
    worker: AgySessionWorker,
    foundKey: string,
  ): WorkerParkSnapshot {
    return {
      sessionId: worker.sessionId,
      nativeSessionId: worker.nativeSessionId ?? "",
      slotKey: worker.account.slotKey,
      accountRef: worker.account.accountRef,
      subagentId: subagentIdFromSessionKey(foundKey),
      minimalAgent: worker.minimalAgent,
      workDir: worker.workDir,
      systemPrompt: worker.systemPrompt,
      appliedSystemHistorySeed: worker.appliedSystemHistorySeed,
      registeredTools: worker.registeredTools,
      committedMessages: worker.committedMessages,
      resumeSupported: worker.resumeSupported,
    };
  }

  /**
   * True when a cleanly finished worker should be swapped out for memory rather
   * than reused. Only IDLE (never AWAITING_TOOL_RESULTS) sessions qualify, and
   * only when the native session can be resumed, so recycling never costs
   * conversation state.
   */
  private shouldRecycleForRss(worker: AgySessionWorker): boolean {
    if (this.maxWorkerRssBytes <= 0) return false;
    if (worker.closed) return false;
    if (worker.state !== "IDLE") return false;
    if (!worker.resumeSupported) return false;
    if (!worker.nativeSessionId) return false;
    // Parking is best-effort: the caller only retires when `parkSession` reports
    // a retained resume source, so a ledger too large for the memory shelf and
    // too seeded for the digest index keeps its warm worker instead.
    return worker.getRssBytes() > this.maxWorkerRssBytes;
  }

  /**
   * Saves this worker's session to the memory and/or digest shelves.
   *
   * Returns whether at least one usable resume source was retained: callers that
   * are about to close the worker must not treat an oversized, seeded ledger as
   * recoverable when neither shelf accepted it.
   */
  private parkSession(worker: AgySessionWorker): boolean {
    const foundKey = this.sessionKeyForWorker(worker);
    return this.shelf.park(
      foundKey,
      this.snapshotForWorker(worker, foundKey),
      Date.now(),
    );
  }

  /** The live worker registered under `sessionKey`, if any. */
  getActiveWorker(sessionKey: string): AgySessionWorker | undefined {
    return this.activeWorkers.get(sessionKey);
  }

  // ---------------------------------------------------------------------------
  // Turn entry
  // ---------------------------------------------------------------------------

  async *executeTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options?: TurnExecutionOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    // The vendor disabled this account on a previous turn: refuse before spawning
    // `agy` again. The status decides whether Magpie asks another account: `403` it
    // does, `409` (with `account_failover` off) it does not, and the user picks.
    const blocked = policyBlockedMessage(account.accountRef);
    if (blocked) {
      const failover =
        options?.providerOptions?.accountFailover ??
        this.providerOptions?.accountFailover ??
        false;
      throw new BridgeHttpError(
        failover ? 403 : 409,
        "permission_error",
        blocked,
      );
    }

    const sessionKey = req.sessionId
      ? `${account.slotKey}::${account.accountRef}::${req.sessionId}${req.subagentId ? "::sub:" + req.subagentId : ""}`
      : null;

    let unlock: (() => void) | null = null;
    let tailPromise: Promise<void> | null = null;
    if (sessionKey) {
      if (signal?.aborted) {
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request was aborted before execution could start",
        );
      }

      let resolveLock!: () => void;
      const currentLock = new Promise<void>((r) => {
        resolveLock = r;
      });
      unlock = resolveLock;

      const prevLock = this.sessionLocks.get(sessionKey) || Promise.resolve();
      tailPromise = prevLock.then(
        () => currentLock,
        () => currentLock,
      );
      this.sessionLocks.set(sessionKey, tailPromise);

      try {
        await prevLock;
      } catch {}

      if (signal?.aborted) {
        unlock();
        if (this.sessionLocks.get(sessionKey) === tailPromise) {
          this.sessionLocks.delete(sessionKey);
        }
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request was aborted while waiting for session lock",
        );
      }
    }

    try {
      yield* this.dispatchTurn(
        account,
        req,
        modelSelection,
        options,
        sessionKey,
        signal,
      );
    } finally {
      if (unlock) {
        unlock();
      }
      if (sessionKey && tailPromise) {
        if (this.sessionLocks.get(sessionKey) === tailPromise) {
          this.sessionLocks.delete(sessionKey);
        }
      }
    }
  }

  private async *dispatchTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options: TurnExecutionOptions | undefined,
    sessionKey: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    // Case 5: Stateless request (req.sessionId === null)
    if (!sessionKey || req.sessionId === null) {
      validateNoOrphanToolResults(req.messages);
      yield* this.executeStatelessTurn(
        account,
        req,
        modelSelection,
        options,
        signal,
      );
      return;
    }

    const requestedMinimalAgent = Boolean(
      options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
    );

    const baseSessionKey = `${account.slotKey}::${account.accountRef}::${req.sessionId}`;
    let existingWorker = this.activeWorkers.get(sessionKey);
    if (!existingWorker && !req.subagentId) {
      for (const [key, worker] of this.activeWorkers) {
        const parts = key.split("::");
        if (
          parts.length === 3 &&
          parts[0] === account.slotKey &&
          parts[2] === req.sessionId
        ) {
          existingWorker = worker;
          break;
        }
      }
    }
    if (!existingWorker) {
      existingWorker = this.adoptAwaitingToolWorker(
        account,
        req,
        sessionKey,
        requestedMinimalAgent,
      );
    }
    if (!existingWorker) {
      existingWorker = this.adoptWarmIdleWorker(
        account,
        req,
        sessionKey,
        requestedMinimalAgent,
      );
    }

    const baseWorker =
      this.activeWorkers.get(baseSessionKey) ??
      (existingWorker && !req.subagentId ? existingWorker : undefined);

    const lastMessage = req.messages[req.messages.length - 1];
    const answersPendingTool = Boolean(
      baseWorker &&
        baseWorker.state === "AWAITING_TOOL_RESULTS" &&
        lastMessage?.role === "user" &&
        lastMessage.content.some((p) => p.type === "tool_result"),
    );

    const isSideRequest = Boolean(
      baseWorker &&
        baseWorker.registeredTools.length > 0 &&
        !answersPendingTool &&
        (req.tools.length === 0 || req.toolChoice.type === "none"),
    );

    if (isSideRequest && baseWorker) {
      validateNoOrphanToolResults(req.messages);
      // Prefer evicting any OTHER idle session before evicting the parent session
      // whose title/classifier side request is currently running.
      const active = this.scheduler.getActiveWorkers();
      const acctWorkers = active.filter(
        (w) =>
          w.account.accountRef === account.accountRef &&
          w.account.slotKey === account.slotKey,
      );
      const canSpareAccountSlot =
        acctWorkers.length < this.scheduler.maxPerAccountWorkers ||
        acctWorkers.some((w) => w !== baseWorker && !w.pinned && w.state === "IDLE");
      const canSpareGlobalSlot =
        active.length < this.scheduler.maxGlobalWorkers ||
        active.some((w) => w !== baseWorker && !w.pinned && w.state === "IDLE");
      const releaseBasePin =
        canSpareAccountSlot && canSpareGlobalSlot ? baseWorker.pin() : null;
      try {
        yield* this.executeStatelessTurn(
          account,
          req,
          modelSelection,
          options,
          signal,
        );
      } finally {
        releaseBasePin?.();
      }
      return;
    }

    if (
      existingWorker &&
      existingWorker.account.accountRef !== account.accountRef
    ) {
      this.removeActiveWorker(existingWorker);
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("account_mismatch");
      existingWorker = undefined;
    }

    if (existingWorker && existingWorker.minimalAgent !== requestedMinimalAgent) {
      this.removeActiveWorker(existingWorker);
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("system_prompt_mode_changed");
      existingWorker = undefined;
    }

    // Fork detection when parent is in AWAITING_TOOL_RESULTS
    if (
      existingWorker &&
      existingWorker.state === "AWAITING_TOOL_RESULTS" &&
      !req.subagentId
    ) {
      const diffSystem = !systemPromptsMatch(
        existingWorker.systemPrompt,
        req.system,
      );
      const diffOpening =
        getOpeningUserText(req.messages) !==
        getOpeningUserText(existingWorker.committedMessages);

      if (diffSystem && diffOpening) {
        validateNoOrphanToolResults(req.messages);
        yield* this.executeStatelessTurn(
          account,
          req,
          modelSelection,
          options,
          signal,
        );
        return;
      }
    }

    // Case 3: Session in AWAITING_TOOL_RESULTS
    if (existingWorker && existingWorker.state === "AWAITING_TOOL_RESULTS") {
      if (!systemPromptsMatch(existingWorker.systemPrompt, req.system)) {
        // The pending call belongs to a native session opened under other
        // instructions, and a continuation delivers tool results without ever
        // applying `req.system`: the request would answer under the old prompt.
        // Cold-replay under the requested one, as a workspace change does.
        this.removeActiveWorker(existingWorker);
        this.scheduler.unregisterWorker(existingWorker);
        await existingWorker.close("system_prompt_changed");
        yield* this.executeFreshSessionTurn(
          account,
          req,
          modelSelection,
          options,
          sessionKey,
          signal,
        );
        return;
      }
      if (
        normalizeWorkDir(existingWorker.workDir) !==
        normalizeWorkDir(req.workDir)
      ) {
        // The native session is bound to the workDir it started with (`--add-dir`
        // plus the workDir disambiguation note), so a workspace switch has to
        // cold-replay under the new workDir instead of continuing this one.
        this.removeActiveWorker(existingWorker);
        this.scheduler.unregisterWorker(existingWorker);
        await existingWorker.close("workdir_changed");
        yield* this.executeFreshSessionTurn(
          account,
          req,
          modelSelection,
          options,
          sessionKey,
          signal,
        );
        return;
      }
      yield* this.executeAwaitingToolsTurn(
        existingWorker,
        req,
        sessionKey,
        modelSelection,
        signal,
        options,
      );
      return;
    }

    // Case 2: Warm IDLE session with matching prefix (exact or `lostMedia`),
    // system prompt, work dir, and compatible tool set.
    if (
      existingWorker &&
      existingWorker.state === "IDLE" &&
      systemPromptsMatch(existingWorker.systemPrompt, req.system) &&
      normalizeWorkDir(existingWorker.workDir) === normalizeWorkDir(req.workDir) &&
      isToolSetCompatible(existingWorker.registeredTools, req.tools)
    ) {
      const warmMatch = matchLedgerPrefix(
        existingWorker.committedMessages,
        req.messages,
      );
      if (warmMatch.matched) {
        yield* this.executeWarmIdleTurn(
          existingWorker,
          req,
          modelSelection,
          sessionKey,
          signal,
          warmMatch.incomingPrefixLength,
          options,
        );
        return;
      }
    }

    // Case 4: Warm IDLE session where history diverged/compacted, tools changed, or workDir changed
    if (existingWorker && existingWorker.state === "IDLE") {
      this.removeActiveWorker(existingWorker);
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("history_diverged_or_tools_changed");
    }

    // Case 1: Fresh session (new session or recreated after retirement)
    yield* this.executeFreshSessionTurn(
      account,
      req,
      modelSelection,
      options,
      sessionKey,
      signal,
    );
  }

  // ---------------------------------------------------------------------------
  // Adoption
  // ---------------------------------------------------------------------------

  private adoptAwaitingToolWorker(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    requestedMinimalAgent: boolean,
  ): AgySessionWorker | undefined {
    const lastMsg = req.messages[req.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user") return undefined;

    const incomingToolUseIds = new Set<string>();
    for (const part of lastMsg.content) {
      if (part.type === "tool_result") {
        incomingToolUseIds.add(part.toolUseId);
      }
    }
    if (incomingToolUseIds.size === 0) return undefined;

    for (const [key, candidate] of this.activeWorkers) {
      if (candidate.pinned) continue;
      if (candidate.state !== "AWAITING_TOOL_RESULTS") continue;
      // A subagent's conversation is its own: without this, a forked transcript
      // carrying another subagent's pending tool-use id adopts that subagent's
      // live worker and resolves its call.
      if (subagentIdFromSessionKey(key) !== (req.subagentId ?? undefined)) continue;
      if (
        candidate.account.slotKey !== account.slotKey ||
        candidate.account.accountRef !== account.accountRef
      ) {
        continue;
      }
      if (candidate.minimalAgent !== requestedMinimalAgent) continue;
      if (normalizeWorkDir(candidate.workDir) !== normalizeWorkDir(req.workDir)) {
        continue;
      }

      const pendingIds = candidate.broker.getExposedPendingIds();
      if (!pendingIds.some((id) => incomingToolUseIds.has(id))) continue;

      if (!req.subagentId) {
        const diffSystem = !systemPromptsMatch(
          candidate.systemPrompt,
          req.system,
        );
        const diffOpening =
          getOpeningUserText(req.messages) !==
          getOpeningUserText(candidate.committedMessages);
        if (diffSystem && diffOpening) continue;
      }

      const matchesPrefix = matchLedgerPrefix(
        candidate.committedMessages,
        req.messages,
      ).matched;
      if (
        !matchesPrefix &&
        !isCompactedRequest(
          req.messages,
          candidate.committedMessages,
          pendingIds,
        )
      ) {
        continue;
      }

      this.removeActiveWorker(candidate);
      if (req.sessionId) {
        candidate.sessionId = req.sessionId;
      }
      this.activeWorkers.set(sessionKey, candidate);
      return candidate;
    }

    return undefined;
  }

  /**
   * Adopts a compatible warm IDLE worker that was parked under another key.
   *
   * Clients rotate their own session id (and subagents open a sibling
   * conversation), so the same conversation can arrive under a new key with the
   * whole transcript: the worker that already holds it is continued instead of
   * being cold-replayed into a second native session.
   */
  private adoptWarmIdleWorker(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    requestedMinimalAgent: boolean,
  ): AgySessionWorker | undefined {
    // A turn that must not call tools is a side request, not a continuation.
    if (req.toolChoice?.type === "none") return undefined;

    let best:
      | { key: string; worker: AgySessionWorker; length: number }
      | undefined;

    for (const [key, candidate] of this.activeWorkers) {
      if (key === sessionKey) continue;
      if (this.sessionLocks.has(key)) continue;
      if (candidate.pinned) continue;
      if (candidate.closed) continue;
      if (candidate.state !== "IDLE") continue;
      if (
        candidate.account.slotKey !== account.slotKey ||
        candidate.account.accountRef !== account.accountRef
      ) {
        continue;
      }
      if (candidate.minimalAgent !== requestedMinimalAgent) continue;
      if (subagentIdFromSessionKey(key) !== (req.subagentId ?? undefined)) {
        continue;
      }
      if (normalizeWorkDir(candidate.workDir) !== normalizeWorkDir(req.workDir)) {
        continue;
      }
      if (!systemPromptsMatch(candidate.systemPrompt, req.system)) continue;
      if (!isToolSetCompatible(candidate.registeredTools, req.tools)) continue;
      if (candidate.committedMessages.length < 2) continue;

      const match = matchLedgerPrefix(candidate.committedMessages, req.messages);
      if (!match.matched) continue;
      // A strict prefix: a candidate that already covers the request has no new
      // turn to run and is not this request's session.
      if (match.incomingPrefixLength >= req.messages.length) continue;

      if (!best || match.incomingPrefixLength > best.length) {
        best = { key, worker: candidate, length: match.incomingPrefixLength };
      }
    }

    if (!best) return undefined;

    this.shelf.consumeMemory(best.key, best.worker.nativeSessionId);
    this.shelf.invalidate(best.key, best.worker.nativeSessionId);
    this.removeActiveWorker(best.worker);
    if (req.sessionId) {
      best.worker.sessionId = req.sessionId;
    }
    this.activeWorkers.set(sessionKey, best.worker);
    return best.worker;
  }

  /**
   * Fails a request that carries images for a worker whose `agy` build cannot
   * take them.
   *
   * `retire` is for a worker created for this very request: it can never serve
   * it, so it is closed instead of being left parked for reuse. A pre-existing
   * worker keeps its session — the caller may still use it without images.
   */
  private async assertImagesSupported(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    retire = false,
  ): Promise<void> {
    if (worker.imageSupported) return;
    if (!requestHasImages(req.messages)) return;
    if (retire) await this.retireWorker(worker, "image_not_supported");
    throw new BridgeHttpError(
      400,
      "invalid_request_error",
      "Images are not supported by the underlying agent",
    );
  }

  /**
   * Folds one turn event into the accumulator: the committed ledger needs the
   * whole answer and every tool call, and the same event decides the outcome.
   */
  private foldTurnEvent(
    fold: TurnFold,
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    event: TurnStreamEvent,
  ): void {
    if (event.type === "tool_use") {
      fold.generatedToolCalls.push(event);
    } else if (event.type === "text_delta") {
      fold.fullAnswerText += event.text;
    } else if (event.type === "error") {
      fold.sawError = true;
    } else if (event.type === "finish") {
      fold.turnFinishedCleanly = true;
      commitAssistantTurn(
        worker,
        req,
        fold.fullAnswerText,
        fold.generatedToolCalls,
      );
      if (fold.generatedToolCalls.length === 0) {
        this.shelf.recordPersisted(
          sessionKey,
          this.snapshotForWorker(worker, sessionKey),
        );
      }
    }
  }

  /**
   * What every stateful turn does once its event loop is done: retire a worker
   * whose turn did not end cleanly, or park and close one whose tree outgrew the
   * RSS ceiling. Runs while the worker is still pinned, because an unpinned IDLE
   * worker becomes evictable immediately and a waiting admission would park the
   * very session this is about to discard.
   */
  private async settleStatefulTurn(
    worker: AgySessionWorker,
    fold: Pick<TurnFold, "sawError" | "turnFinishedCleanly">,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const why = fold.sawError
      ? "turn_error"
      : this.shouldRetireUnfinishedTurn(worker, fold.turnFinishedCleanly, signal);
    if (why) {
      await this.retireWorker(worker, why);
      return;
    }
    if (!fold.turnFinishedCleanly || !this.shouldRecycleForRss(worker)) return;
    // Park first, while the session key is still registered, so the next turn
    // resumes this exact conversation in a fresh process.
    if (this.parkSession(worker)) {
      await this.retireWorker(worker, "rss_limit_exceeded");
    }
  }

  // ---------------------------------------------------------------------------
  // Retirement
  // ---------------------------------------------------------------------------

  private removeActiveWorker(worker: AgySessionWorker): void {
    for (const [key, w] of this.activeWorkers) {
      if (w === worker) {
        this.activeWorkers.delete(key);
      }
    }
  }

  /**
   * Drops a worker from every registry and closes it. Used whenever a turn ended
   * in a state that cannot be trusted for reuse (error, abandoned mid-turn).
   */
  private async retireWorker(
    worker: AgySessionWorker,
    reason: string,
  ): Promise<void> {
    this.removeActiveWorker(worker);
    this.scheduler.unregisterWorker(worker);
    await worker.close(reason);
  }

  /**
   * Whether an interrupted turn must take its worker out of service.
   *
   * Finishing cleanly never retires. A deliberate client abort while the agent
   * is still generating is left to the worker's own `handleClientAbort`, which
   * either settles the prompt back to `IDLE` or closes an unsettled worker —
   * retiring here would defeat that recovery. Everything else is uncommitted
   * state: an `error` frame, an abandoned consumer that unwound mid-generation,
   * or a `tool_use` the caller never received (so no ledger and no tool ids).
   */
  private shouldRetireUnfinishedTurn(
    worker: AgySessionWorker,
    turnFinishedCleanly: boolean,
    signal?: AbortSignal,
  ): "turn_error" | "turn_aborted" | null {
    if (turnFinishedCleanly || worker.state === "CLOSED") return null;
    if (worker.state === "AWAITING_TOOL_RESULTS") return "turn_aborted";
    if (worker.state !== "GENERATING") return null;
    if (signal?.aborted === true) return null;
    return "turn_aborted";
  }

  // ---------------------------------------------------------------------------
  // Case 1: fresh (or recreated) session
  // ---------------------------------------------------------------------------

  private async *executeFreshSessionTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options: TurnExecutionOptions | undefined,
    sessionKey: string,
    signal?: AbortSignal,
    /**
     * Set when this cold start is itself the recovery from a checkpoint that
     * could not be invalidated. A second such failure fails the turn instead of
     * handing off again, so an unwritable data root cannot recurse forever.
     */
    recoveringFromInvalidation = false,
  ): AsyncGenerator<TurnStreamEvent> {
    validateNoOrphanToolResults(req.messages);

    const requestedMinimalAgent = Boolean(
      options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
    );
    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;

    const { priorMessages, currentMessages } = splitPriorAndCurrent(
      req.messages,
    );
    // Off unless something said otherwise: the option's own default is false, and
    // a fallback of `true` here silently cloaked every caller that passed neither.
    const cloakPrompts =
      options?.providerOptions?.cloakPrompts ??
      this.providerOptions?.cloakPrompts ??
      false;
    const coldPlan = planColdHistoryRender(
      priorMessages,
      currentMessages,
      modelSelection.rawModelId,
      utf8Bytes(
        buildEffectiveSystemText(
          req.system,
          req.workDir,
          cloakPrompts,
          this.providerOptions?.cloakSaidAs ?? options?.providerOptions?.cloakSaidAs,
        ),
      ),
    );
    const accountFailover =
      options?.providerOptions?.accountFailover ??
      this.providerOptions?.accountFailover ??
      false;
    const workerOptions: WorkerOptions = {
      spawnFn,
      accountFailover,
      minimalAgent:
        options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
      exposeThinking: req.thinkingEnabled,
      cloakPrompts,
      workDir: req.workDir,
      systemPrompt: req.system,
      systemHistorySeed: coldPlan.systemHistorySeed,
      tools: req.tools,
      toolChoice: req.toolChoice,
      steerCancelTimeoutMs:
        options?.steerCancelTimeoutMs ??
        this.options?.steerCancelTimeoutMs,
      steerToolCommitTimeoutMs:
        options?.steerToolCommitTimeoutMs ??
        this.options?.steerToolCommitTimeoutMs,
      measureRssBytes: options?.measureRssBytes,
      onStateChange: (_worker, _oldState, newState) => {
        if (newState === "CLOSED") {
          this.removeActiveWorker(_worker);
          this.scheduler.unregisterWorker(_worker);
        }
      },
    };

    const worker = new AgySessionWorker(
      account,
      req.sessionId!,
      this.mcpServer,
      workerOptions,
    );
    // Turn-outcome flags are declared outside the `try` so the `finally` can
    // retire a worker whose turn ended without a clean `finish` (an error frame,
    // or a consumer that unwound the generator mid-turn, e.g. the SSE/JSON
    // encoders calling `iterator.return()` on `{ type: "error" }`).
    const releasePin = worker.pin();
    const fold = newTurnFold();
    let resumeSource: ClaimedShelfResume | null = null;
    let started = false;
    let handedOff = false;

    try {
      try {
        await this.scheduler.reserveAndRegister(worker, signal);
      } catch (err) {
        await worker.close("admission_or_start_failed");
        throw err;
      }
      this.activeWorkers.set(sessionKey, worker);

      try {
        if (signal?.aborted) {
          throw new BridgeHttpError(
            499,
            "invalid_request_error",
            "Request aborted before the worker could start",
          );
        }
        // Exactly one resume source, memory first then the digest index. A stale
        // in-memory entry is dropped inside the shelf so it can never donate its
        // ledger or system-history seed to a session resumed from disk (HIGH-3).
        //
        // The claim runs synchronously and only once this turn owns the session
        // (registered above, still pinned): it reserves the native session id
        // before the first `await` inside it, so two forks racing on the same
        // conversation cannot both be handed the same `agy` session, and the
        // session it claims is already this turn's own warm entry.
        resumeSource = this.shelf.claimResume({
          account,
          req,
          sessionKey,
          requestedMinimalAgent,
          now: Date.now(),
          hasCustomSpawnFn: Boolean(spawnFn),
          isKeyBusy: (key) =>
            key !== sessionKey &&
            (this.sessionLocks.has(key) || this.activeWorkers.has(key)),
        });
        workerOptions.resumeSessionId = resumeSource?.entry.nativeSessionId;
        workerOptions.resumeSystemHistorySeed =
          resumeSource?.kind === "memory"
            ? resumeSource.entry.systemHistorySeed
            : undefined;
        await worker.start(signal);
        started = true;
      } catch (err) {
        this.removeActiveWorker(worker);
        this.scheduler.unregisterWorker(worker);
        await worker.close("admission_or_start_failed");
        throw err;
      }

      if (worker.resumedFromShelf && resumeSource) {
        if (resumeSource.kind === "memory") {
          // Bind only THIS entry's ledger, never a competing persisted one.
          worker.committedMessages = [...resumeSource.entry.committedMessages];
          worker.registeredTools = [...resumeSource.entry.registeredTools];
        } else {
          // Rebuild the ledger from the matched prefix only; the digests prove
          // this slice of the incoming transcript is the pre-restart
          // conversation.
          worker.committedMessages = req.messages.slice(
            0,
            resumeSource.matchedPrefixLength,
          );
          worker.registeredTools = [...req.tools];
        }
        handedOff = true;
        yield* this.executeWarmIdleTurn(
          worker,
          req,
          modelSelection,
          sessionKey,
          signal,
          resumeSource.matchedPrefixLength,
          options,
          recoveringFromInvalidation,
        );
        return;
      }

      await this.assertImagesSupported(worker, req, true);

      await worker.applyModelSelection(modelSelection, signal);

      const promptParts = worker.systemHistorySeedApplied
        ? renderMessagesToPrompt(coldPlan.tailPriorMessages, currentMessages, {
            priorSeededInSystem: true,
            imageSourceMessages: priorMessages,
            cloakUser: cloakPrompts,
          })
        : renderMessagesToPrompt(priorMessages, currentMessages, { cloakUser: cloakPrompts });
      appendToolChoiceReminder(promptParts, req);

      if (worker.effectiveSystemPrompt && !worker.appendSystemSupported) {
        unshiftSystemInstructions(promptParts, worker.effectiveSystemPrompt);
      }

      // Advancing a native session past its checkpoint must be unconditional:
      // an un-removable older checkpoint would later be resumed as if it still
      // described this conversation. When the index cannot be updated, retire
      // this worker before it advances and start a fresh session instead.
      if (!this.shelf.invalidate(sessionKey, worker.nativeSessionId)) {
        await this.retireWorker(worker, "checkpoint_invalidation_failed");
        handedOff = true;
        if (recoveringFromInvalidation) {
          throw new BridgeHttpError(
            500,
            "api_error",
            "Could not update the session index before starting this turn.",
          );
        }
        yield* this.executeFreshSessionTurn(
          account,
          req,
          modelSelection,
          options,
          sessionKey,
          signal,
          true,
        );
        return;
      }
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        this.foldTurnEvent(fold, worker, req, sessionKey, event);
        yield event;
      }
    } finally {
      // Retirement and RSS recycling run while the worker is still pinned: an
      // unpinned IDLE worker becomes evictable immediately, and a waiting
      // admission would park the very session we are about to discard as
      // failed. Release last, in an inner `finally`, so a throw cannot strand it.
      try {
        if (started && !handedOff) {
          // A fresh worker has no previously committed turns to preserve: any
          // uncommitted exit must retire it from coordinator and scheduler alike.
          await this.settleStatefulTurn(worker, fold, signal);
        }
      } finally {
        releasePin();
        resumeSource?.release();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Case 2: warm IDLE session
  // ---------------------------------------------------------------------------

  private async *executeWarmIdleTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    sessionKey: string,
    signal?: AbortSignal,
    matchedPrefixLength?: number,
    options?: TurnExecutionOptions,
    recoveringFromInvalidation = false,
  ): AsyncGenerator<TurnStreamEvent> {
    const releasePin = worker.pin();
    const fold = newTurnFold();
    let handedOff = false;
    let promptStarted = false;
    try {
      await this.assertImagesSupported(worker, req);

      worker.setExposeThinking(req.thinkingEnabled);
      await worker.applyModelSelection(modelSelection, signal);
      worker.broker.setToolChoice(req.toolChoice);

      // Slice at the *matched* index, not at the ledger length: a client that
      // dropped an earlier turn's images leaves the ledger covering more
      // messages than the incoming transcript does, and slicing by length would
      // swallow this turn's actual question.
      const prefixLen = matchedPrefixLength ?? worker.committedMessages.length;
      const deltaMessages = req.messages.slice(prefixLen);
      const promptParts = renderMessagesToPrompt([], deltaMessages, {
        cloakUser:
          options?.providerOptions?.cloakPrompts ??
          this.providerOptions?.cloakPrompts ??
          false,
      });
      appendToolChoiceReminder(promptParts, req);

      // Same rule as the cold path: never advance a warm native session while an
      // older checkpoint for it is still resumable from the index.
      if (!this.shelf.invalidate(sessionKey, worker.nativeSessionId)) {
        await this.retireWorker(worker, "checkpoint_invalidation_failed");
        handedOff = true;
        if (recoveringFromInvalidation) {
          throw new BridgeHttpError(
            500,
            "api_error",
            "Could not update the session index before starting this turn.",
          );
        }
        yield* this.executeFreshSessionTurn(
          worker.account,
          req,
          modelSelection,
          options,
          sessionKey,
          signal,
          true,
        );
        return;
      }
      promptStarted = true;
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        this.foldTurnEvent(fold, worker, req, sessionKey, event);
        yield event;
      }
    } finally {
      try {
        if (promptStarted && !handedOff) {
          await this.settleStatefulTurn(worker, fold, signal);
        }
      } finally {
        releasePin();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Case 3: session awaiting tool results
  // ---------------------------------------------------------------------------

  private async *executeAwaitingToolsTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    modelSelection: ModelSelection,
    signal?: AbortSignal,
    options?: TurnExecutionOptions,
  ): AsyncGenerator<TurnStreamEvent> {
    const releasePin = worker.pin();
    const fold = newTurnFold();
    if (options?.steerCancelTimeoutMs !== undefined) {
      worker.steerCancelTimeoutMs = options.steerCancelTimeoutMs;
    }
    if (options?.steerToolCommitTimeoutMs !== undefined) {
      worker.steerToolCommitTimeoutMs = options.steerToolCommitTimeoutMs;
    }
    let handedOff = false;
    let continuationStarted = false;
    try {
      // Verify the incoming transcript still carries this ledger (exactly, or
      // with only earlier images taken out).
      const match = matchLedgerPrefix(worker.committedMessages, req.messages);
      if (!match.matched) {
        if (
          isCompactedRequest(
            req.messages,
            worker.committedMessages,
            worker.broker.getExposedPendingIds(),
          )
        ) {
          this.removeActiveWorker(worker);
          this.scheduler.unregisterWorker(worker);
          await worker.close("compacted_during_tool_turn");
          handedOff = true;
          yield* this.executeFreshSessionTurn(
            worker.account,
            req,
            modelSelection,
            options,
            sessionKey,
            signal,
          );
          return;
        }

        // Branching while tool calls are pending!
        throw new BridgeHttpError(
          409,
          "invalid_request_error",
          "Cannot branch session while tool calls are pending",
        );
      }

      // Delta messages after the matched prefix.
      const deltaMessages = req.messages.slice(match.incomingPrefixLength);
      const lastMsg = deltaMessages[deltaMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "user") {
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          "Expected user message containing tool results",
        );
      }

      const toolResults: ToolResultDelivery[] = [];
      const steeringParts: NormalizedContentPart[] = [];

      for (const part of lastMsg.content) {
        if (part.type === "tool_result") {
          toolResults.push({
            toolUseId: part.toolUseId,
            isError: part.isError,
            content: [...part.content],
          });
        }
      }

      collectSteeringParts(lastMsg.content, toolResults, steeringParts);

      const toolsChanged = !isToolSetCompatible(worker.registeredTools, req.tools);
      if (toolsChanged) {
        const regNames = new Set(worker.registeredTools.map((t) => t.name));
        const hasNewTools = req.tools.some((t) => !regNames.has(t.name));
        worker.broker.setTools(req.tools);
        worker.registeredTools = [...req.tools];
        steeringParts.push({
          type: "text",
          text: hasNewTools
            ? "Continue with the newly loaded tools."
            : "Continue with the updated tools.",
        });
      }

      worker.setExposeThinking(req.thinkingEnabled);
      worker.broker.setToolChoice(req.toolChoice);

      let yieldedAny = false;
      // The tool results are about to move the native session forward, so the
      // older checkpoint has to be gone first; if it cannot be removed, hand the
      // request to a fresh session rather than leave a stale resume source.
      if (!this.shelf.invalidate(sessionKey, worker.nativeSessionId)) {
        await this.retireWorker(worker, "checkpoint_invalidation_failed");
        handedOff = true;
        yield* this.executeFreshSessionTurn(
          worker.account,
          req,
          modelSelection,
          options,
          sessionKey,
          signal,
          true,
        );
        return;
      }
      try {
        continuationStarted = true;
        for await (const event of worker.continueWithToolResults(
          toolResults,
          steeringParts,
          signal,
          modelSelection,
        )) {
          yieldedAny = true;
          this.foldTurnEvent(fold, worker, req, sessionKey, event);
          yield event;
        }
      } catch (err) {
        if (err instanceof SteerReplayNeededError && !yieldedAny) {
          this.removeActiveWorker(worker);
          this.scheduler.unregisterWorker(worker);
          await worker.close("steer_replay_needed");
          handedOff = true;
          yield* this.executeFreshSessionTurn(
            worker.account,
            req,
            modelSelection,
            options,
            sessionKey,
            signal,
          );
          return;
        }
        throw err;
      }
    } finally {
      try {
        if (!handedOff && continuationStarted) {
          await this.settleStatefulTurn(worker, fold, signal);
        }
      } finally {
        releasePin();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Case 5: stateless turn
  // ---------------------------------------------------------------------------

  private async *executeStatelessTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options: TurnExecutionOptions | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    const ephemeralSessionId = `ephemeral-${crypto.randomUUID()}`;
    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
    // Off unless something said otherwise: the option's own default is false, and
    // a fallback of `true` here silently cloaked every caller that passed neither.
    const cloakPrompts =
      options?.providerOptions?.cloakPrompts ??
      this.providerOptions?.cloakPrompts ??
      false;
    const { priorMessages, currentMessages } = splitPriorAndCurrent(
      req.messages,
    );
    const coldPlan = planColdHistoryRender(
      priorMessages,
      currentMessages,
      modelSelection.rawModelId,
      utf8Bytes(
        buildEffectiveSystemText(
          req.system,
          req.workDir,
          cloakPrompts,
          this.providerOptions?.cloakSaidAs ?? options?.providerOptions?.cloakSaidAs,
        ),
      ),
    );
    const worker = new AgySessionWorker(
      account,
      ephemeralSessionId,
      this.mcpServer,
      {
        spawnFn,
        minimalAgent:
          options?.providerOptions?.minimalAgent ??
          this.providerOptions?.minimalAgent ??
          false,
        exposeThinking: req.thinkingEnabled,
        cloakPrompts,
        accountFailover:
          options?.providerOptions?.accountFailover ??
          this.providerOptions?.accountFailover ??
          false,
        workDir: req.workDir,
        systemPrompt: req.system,
        systemHistorySeed: coldPlan.systemHistorySeed,
        tools: req.tools,
        toolChoice: req.toolChoice,
        measureRssBytes: options?.measureRssBytes,
      },
    );
    const releasePin = worker.pin();

    try {
      try {
        await this.scheduler.reserveAndRegister(worker, signal);
      } catch (err) {
        await worker.close("admission_or_start_failed");
        throw err;
      }

      try {
        await worker.start(signal);
      } catch (err) {
        this.scheduler.unregisterWorker(worker);
        await worker.close("admission_or_start_failed");
        throw err;
      }

      await this.assertImagesSupported(worker, req);

      await worker.applyModelSelection(modelSelection, signal);

      const promptParts = worker.systemHistorySeedApplied
        ? renderMessagesToPrompt(coldPlan.tailPriorMessages, currentMessages, {
            priorSeededInSystem: true,
            imageSourceMessages: priorMessages,
            cloakUser: cloakPrompts,
          })
        : renderMessagesToPrompt(priorMessages, currentMessages, { cloakUser: cloakPrompts });
      appendToolChoiceReminder(promptParts, req);
      if (worker.effectiveSystemPrompt && !worker.appendSystemSupported) {
        unshiftSystemInstructions(promptParts, worker.effectiveSystemPrompt);
      }
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        yield event;
      }
    } finally {
      releasePin();
      this.scheduler.unregisterWorker(worker);
      await worker.close("stateless_turn_finished");
    }
  }
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

/**
 * The accumulator a stateful turn folds its event stream into. The ledger the
 * turn commits needs the whole answer and every tool call, and the same events
 * decide whether the worker may be reused afterwards.
 */
interface TurnFold {
  generatedToolCalls: GeneratedToolCall[];
  fullAnswerText: string;
  sawError: boolean;
  turnFinishedCleanly: boolean;
}

function newTurnFold(): TurnFold {
  return {
    generatedToolCalls: [],
    fullAnswerText: "",
    sawError: false,
    turnFinishedCleanly: false,
  };
}

/** The ledger a finished turn leaves behind (prefill is merged, not appended). */
function commitAssistantTurn(
  worker: AgySessionWorker,
  req: NormalizedAnthropicRequest,
  fullAnswerText: string,
  generatedToolCalls: GeneratedToolCall[],
): void {
  worker.committedMessages = buildCommittedMessages(
    req.messages,
    fullAnswerText,
    generatedToolCalls,
  );
}

type PromptParts = ReturnType<typeof renderMessagesToPrompt>;

function appendToolChoiceReminder(
  promptParts: PromptParts,
  req: NormalizedAnthropicRequest,
): void {
  const reminder = getToolChoiceReminder(req.toolChoice);
  if (!reminder) return;
  const last = promptParts[promptParts.length - 1];
  if (last && last.type === "text") {
    last.text += `\n\n${reminder}`;
  } else {
    promptParts.push({ type: "text", text: reminder });
  }
}

/**
 * `agy` without `systemPrompt.append` cannot be told a system prompt directly,
 * so it rides at the head of the user text — with the same image fitting as any
 * other part.
 */
function unshiftSystemInstructions(
  promptParts: PromptParts,
  effectiveSystemPrompt: string,
): void {
  const sysPrompt = `<external_system_instructions>\n${effectiveSystemPrompt}\n</external_system_instructions>\n\n`;
  const first = promptParts[0];
  if (first && first.type === "text") {
    promptParts[0] = { type: "text", text: `${sysPrompt}${first.text}` };
  } else {
    promptParts.unshift({ type: "text", text: sysPrompt });
  }
}

const TELEMETRY_NOISE_RE =
  /^\s*<system-reminder>\s*(?:Token usage:|USD budget:|<total_tokens>|Output tokens \u2014 turn:)[\s\S]*?<\/system-reminder>\s*$/i;
const QUEUED_USER_RE =
  /The user sent (?:a new message while you were working|the following message):\s*([\s\S]*?)(?:<\/system-reminder>|$)/i;
const COMPANION_RE =
  /^(?:<system-reminder\b|<task-notification\b|Tools? loaded\b|Base directory for this skill:|ARGUMENTS:|Skill arguments:)/i;

/**
 * Splits a tool-result turn's remaining content into steering and companion
 * notices.
 *
 * A harness reminder (a hook's context, a task notification, a loaded skill)
 * belongs *inside* the tool result so `agy` keeps going without cancelling the
 * turn; only genuine user text or an image is steering.
 */
function collectSteeringParts(
  content: NormalizedContentPart[],
  toolResults: ToolResultDelivery[],
  steeringParts: NormalizedContentPart[],
): void {
  for (const part of content) {
    if (part.type === "tool_result") continue;

    if (part.type === "image") {
      const fitted = fitInlineImage(part.mediaType, part.data);
      steeringParts.push({
        type: "image",
        // Fitting only ever returns the original type or a re-encoded
        // JPEG/PNG, both of which the wire union already allows.
        mediaType: fitted.mediaType as ImageMediaType,
        data: fitted.data,
      });
      continue;
    }

    if (part.type === "text") {
      const text = part.text.trim();
      if (!text) continue;

      if (TELEMETRY_NOISE_RE.test(part.text)) continue;

      const queuedMatch = QUEUED_USER_RE.exec(part.text);
      if (queuedMatch) {
        const inner = queuedMatch[1]!
          .replace(
            /\n\n(?:This is how Claude Code surfaces[\s\S]*|IMPORTANT:[\s\S]*|Please address this message[\s\S]*)$/i,
            "",
          )
          .trim();
        steeringParts.push({ type: "text", text: inner });
        continue;
      }

      if (
        COMPANION_RE.test(text) ||
        /^\[MESSAGE FROM NON-USER SOURCE/i.test(text) ||
        /hook (?:additional context|success|blocking error|feedback)/i.test(text)
      ) {
        const lastResult = toolResults[toolResults.length - 1];
        if (lastResult) {
          lastResult.content.push({ type: "text", text: part.text });
        }
        continue;
      }

      steeringParts.push(part);
    }
  }
}
