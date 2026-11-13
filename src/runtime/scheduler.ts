import { BridgeHttpError, type AccountDescriptor } from "../types";
import { sweepStaleWorkspaces, type AgySessionWorker } from "./worker";

export interface GlobalSchedulerOptions {
  maxGlobalWorkers?: number;
  maxPerAccountWorkers?: number;
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  awaitingToolTimeoutMs?: number;
  /** Bounded Wait-for-Room; `0` restores the immediate `503`. */
  waitTimeoutMs?: number;
  /** Cap on parked admission requests; beyond it the request fails fast. */
  maxWaiters?: number;
  installSignalHandlers?: boolean;
}

const BUSY_MESSAGE =
  "All Antigravity session workers are busy or awaiting tool results";

interface CapacityWaiter {
  account: AccountDescriptor;
  workerToRegister: AgySessionWorker;
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

interface CapacityVictim {
  worker: AgySessionWorker;
  reason: string;
}

type AcquireResult =
  | { admitted: true; victims: CapacityVictim[] }
  | { admitted: false };

/**
 * Reads a non-negative integer override from the environment. `0` is meaningful
 * (it disables waiting), so a plain truthiness check would be wrong here.
 */
function envNonNegInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/**
 * Reads a strictly positive integer override. Used for capacities, where `0` or
 * a non-numeric value (which `parseInt` would turn into `NaN`) is not a usable
 * limit and must fall back to the default.
 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

const globalActiveSchedulers = new Set<GlobalScheduler>();
let globalSignalsInstalled = false;

function installGlobalSignalHandlersOnce(): void {
  if (globalSignalsInstalled) return;
  globalSignalsInstalled = true;

  process.once("exit", () => {
    for (const s of Array.from(globalActiveSchedulers)) {
      s.closeAllSync("process_exit");
    }
  });

  process.once("SIGINT", () => {
    void Promise.allSettled(
      Array.from(globalActiveSchedulers).map((s) => s.closeAll("SIGINT")),
    ).finally(() => {
      process.exit(130);
    });
  });

  process.once("SIGTERM", () => {
    void Promise.allSettled(
      Array.from(globalActiveSchedulers).map((s) => s.closeAll("SIGTERM")),
    ).finally(() => {
      process.exit(143);
    });
  });
}

export class GlobalScheduler {
  readonly maxGlobalWorkers: number;
  readonly maxPerAccountWorkers: number;
  readonly idleTimeoutMs: number;
  readonly reaperIntervalMs: number;
  readonly awaitingToolTimeoutMs: number;
  readonly waitTimeoutMs: number;
  readonly maxWaiters: number;

  /**
   * Owners of the two lifecycle events. A hook set keeps several listeners
   * independent instead of forcing each new owner to capture and re-wrap a
   * single callback property.
   */
  private readonly beforeEvictIdleHooks = new Set<
    (worker: AgySessionWorker) => void
  >();
  private readonly reapTickHooks = new Set<(now: number) => void>();

  private readonly workers = new Set<AgySessionWorker>();
  private readonly waiters: CapacityWaiter[] = [];
  private drainingWaiters = false;
  private drainRequested = false;
  private shuttingDown = false;
  private reaperTimer?: ReturnType<typeof setInterval>;

  constructor(options?: GlobalSchedulerOptions) {
    const envMax = envPositiveInt("AGY_BRIDGE_MAX_PROCS");

    this.maxGlobalWorkers = options?.maxGlobalWorkers ?? envMax ?? 16;
    this.maxPerAccountWorkers = options?.maxPerAccountWorkers ?? 6;
    // Match Magpie's official Claude subscription bridge (`idleLongest = time.Hour`,
    // `claude_subscription.go:135`): keep idle warm sessions alive across the 1-hour
    // prompt-cache window instead of evicting after 10m and replaying history cold.
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 60 * 60 * 1000; // 1 hour
    this.awaitingToolTimeoutMs = options?.awaitingToolTimeoutMs ?? 10 * 60 * 1000; // 10 minutes
    // Magpie's Claude bridge waits up to 2m for a room (`claude_room.go`); a
    // bounded wait keeps a subagent fan-out peak from turning into hard 503s.
    this.waitTimeoutMs =
      options?.waitTimeoutMs ??
      envNonNegInt("AGY_BRIDGE_WAIT_TIMEOUT_MS") ??
      60_000;
    this.maxWaiters = options?.maxWaiters ?? 128;
    this.reaperIntervalMs = options?.reaperIntervalMs ?? 60 * 1000; // 1 minute

    this.reaperTimer = setInterval(() => {
      void this.reapIdleWorkers();
    }, this.reaperIntervalMs);

    if (typeof this.reaperTimer.unref === "function") {
      this.reaperTimer.unref();
    }

    if (options?.installSignalHandlers) {
      globalActiveSchedulers.add(this);
      installGlobalSignalHandlersOnce();
    }
  }

  registerWorker(worker: AgySessionWorker): void {
    this.workers.add(worker);
    // Real workers expose a capacity hook; plain test doubles simply have none.
    const attach = (
      worker as { setSchedulerCapacityListener?: (fn: () => void) => void }
    ).setSchedulerCapacityListener;
    if (typeof attach === "function") {
      try {
        attach.call(worker, () => this.notifyCapacityChanged());
      } catch {}
    }
  }

  unregisterWorker(worker: AgySessionWorker): void {
    this.workers.delete(worker);
    this.notifyCapacityChanged();
  }

  getActiveWorkers(): AgySessionWorker[] {
    return Array.from(this.workers).filter((w) => w.state !== "CLOSED");
  }

  getActiveCount(): number {
    return this.getActiveWorkers().length;
  }

  getAccountWorkerCount(accountRef: string, slotKey?: string): number {
    return this.getActiveWorkers().filter((w) => {
      if (slotKey) {
        return (
          w.account.accountRef === accountRef && w.account.slotKey === slotKey
        );
      }
      return w.account.accountRef === accountRef;
    }).length;
  }

  private busyError(): BridgeHttpError {
    return new BridgeHttpError(503, "overloaded_error", BUSY_MESSAGE);
  }

  private abortedError(): BridgeHttpError {
    return new BridgeHttpError(
      499,
      "invalid_request_error",
      "Request aborted while waiting for session capacity",
    );
  }

  private closedError(): BridgeHttpError {
    return new BridgeHttpError(503, "overloaded_error", "Scheduler closed");
  }

  private isAwaitingToolExpired(worker: AgySessionWorker, now: number): boolean {
    return (
      worker.state === "AWAITING_TOOL_RESULTS" &&
      worker.lastActivityAt >= 1_000_000_000 &&
      now - worker.lastActivityAt >= this.awaitingToolTimeoutMs
    );
  }

  private isEvictable(worker: AgySessionWorker, now: number): boolean {
    return (
      !worker.pinned &&
      (worker.state === "IDLE" || this.isAwaitingToolExpired(worker, now))
    );
  }

  private pickEvictable(
    pool: AgySessionWorker[],
    now: number,
  ): AgySessionWorker | null {
    const evictable = pool
      .filter((w) => this.isEvictable(w, now))
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return evictable[0] ?? null;
  }

  /**
   * Atomically admits one worker (or one bare slot) if capacity allows.
   *
   * Victim removal and the new registration happen in the same synchronous
   * turn, so a `Promise.all` burst can never observe an over-capacity
   * scheduler, and no lock is ever held across a wait — a request blocked on a
   * full account does not delay an unrelated account with free slots.
   */
  private tryAcquireNow(
    account: AccountDescriptor,
    workerToRegister?: AgySessionWorker,
  ): AcquireResult {
    const now = Date.now();
    const accountKey = `${account.accountRef}::${account.slotKey}`;
    if (this.shuttingDown) return { admitted: false };
    const active = this.getActiveWorkers();
    const accountWorkers = active.filter(
      (w) => `${w.account.accountRef}::${w.account.slotKey}` === accountKey,
    );

    const victims: CapacityVictim[] = [];
    let remaining = active;

    if (accountWorkers.length >= this.maxPerAccountWorkers) {
      const victim = this.pickEvictable(accountWorkers, now);
      if (!victim) return { admitted: false };
      victims.push({ worker: victim, reason: "evicted_account_lru" });
      remaining = active.filter((w) => w !== victim);
    }

    if (remaining.length >= this.maxGlobalWorkers) {
      const victim = this.pickEvictable(
        remaining.filter((w) => !victims.some((v) => v.worker === w)),
        now,
      );
      if (!victim) return { admitted: false };
      victims.push({ worker: victim, reason: "evicted_global_lru" });
    }

    for (const victim of victims) {
      this.workers.delete(victim.worker);
      this.notifyEvictIdle(victim.worker);
    }
    if (workerToRegister) this.registerWorker(workerToRegister);
    return { admitted: true, victims };
  }

  private async closeVictims(victims: CapacityVictim[]): Promise<void> {
    if (victims.length === 0) return;
    await Promise.allSettled(victims.map((v) => v.worker.close(v.reason)));
  }

  async reserveAndRegister(
    worker: AgySessionWorker,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.shuttingDown) throw this.closedError();
    const acquired = this.tryAcquireNow(worker.account, worker);
    if (acquired.admitted) {
      await this.closeVictims(acquired.victims);
      return;
    }
    await this.waitForRoom(worker.account, worker, signal);
  }

  /**
   * Admits a worker or frees a slot *now*; never queues.
   *
   * A queueable bare admission would be unsound: the waiter registers no worker,
   * so waking several of them on one capacity notification would hand the same
   * released slot to all of them before any continuation could register. Callers
   * that must wait use `reserveAndRegister`, which registers synchronously.
   */
  async ensureCapacity(
    account: AccountDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.shuttingDown) throw this.closedError();
    if (signal?.aborted) throw this.abortedError();
    const acquired = this.tryAcquireNow(account);
    if (acquired.admitted) {
      await this.closeVictims(acquired.victims);
      return;
    }
    throw this.busyError();
  }

  /** Parks the request in FIFO order until a slot frees or the bound expires. */
  private waitForRoom(
    account: AccountDescriptor,
    workerToRegister: AgySessionWorker,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(this.abortedError());
    if (
      this.shuttingDown ||
      this.waitTimeoutMs <= 0 ||
      this.waiters.length >= this.maxWaiters
    ) {
      return Promise.reject(this.busyError());
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const waiter: CapacityWaiter = {
        account,
        workerToRegister,
        resolve,
        reject,
        cleanup: () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener("abort", onAbort);
        },
      };

      // Arrow bound to `this` so the abort listener keeps the scheduler
      // instance when it fires from the signal's dispatch.
      const onAbort = (): void => {
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(this.abortedError());
      };

      timer = setTimeout(() => {
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(this.busyError());
      }, this.waitTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Capacity transitions (a worker closed, went IDLE, or was unpinned) park
   * requests here instead of polling.
   */
  notifyCapacityChanged(): void {
    if (this.drainingWaiters) {
      this.drainRequested = true;
      return;
    }
    this.drainingWaiters = true;
    try {
      do {
        this.drainRequested = false;
        this.drainWaitersOnce();
      } while (this.drainRequested);
    } finally {
      this.drainingWaiters = false;
    }
  }

  private drainWaitersOnce(): void {
    for (const waiter of [...this.waiters]) {
      if (!this.waiters.includes(waiter)) continue;
      let acquired: AcquireResult;
      try {
        acquired = this.tryAcquireNow(waiter.account, waiter.workerToRegister);
      } catch (err) {
        this.removeWaiter(waiter);
        waiter.cleanup();
        waiter.reject(err);
        continue;
      }
      if (!acquired.admitted) continue;
      this.removeWaiter(waiter);
      waiter.cleanup();
      void this.closeVictims(acquired.victims).then(
        () => waiter.resolve(),
        () => waiter.resolve(),
      );
    }
  }

  private removeWaiter(waiter: CapacityWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private rejectAllWaiters(reason: string): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      try {
        waiter.cleanup();
      } catch {}
      try {
        waiter.reject(new BridgeHttpError(503, "overloaded_error", reason));
      } catch {}
    }
  }

  /**
   * Registers a hook run before an idle worker is evicted (reaped or closed to
   * make room). Returns an idempotent unregister.
   */
  addBeforeEvictIdleHook(
    hook: (worker: AgySessionWorker) => void,
  ): () => void {
    this.beforeEvictIdleHooks.add(hook);
    return () => {
      this.beforeEvictIdleHooks.delete(hook);
    };
  }

  /** Registers a hook run once per reaper tick. Returns an idempotent unregister. */
  addReapTickHook(hook: (now: number) => void): () => void {
    this.reapTickHooks.add(hook);
    return () => {
      this.reapTickHooks.delete(hook);
    };
  }

  private notifyEvictIdle(worker: AgySessionWorker): void {
    if (worker.state === "IDLE") {
      for (const hook of Array.from(this.beforeEvictIdleHooks)) {
        try {
          hook(worker);
        } catch {}
      }
    }
  }

  private notifyReapTick(now: number): void {
    for (const hook of Array.from(this.reapTickHooks)) {
      try {
        hook(now);
      } catch {}
    }
  }

  async reapIdleWorkers(): Promise<number> {
    const now = Date.now();
    this.notifyReapTick(now);
    try {
      sweepStaleWorkspaces(now);
    } catch {}
    let count = 0;
    for (const worker of Array.from(this.workers)) {
      if (worker.pinned) {
        continue;
      }
      if (
        worker.state === "IDLE" &&
        now - worker.lastActivityAt >= this.idleTimeoutMs
      ) {
        this.workers.delete(worker);
        this.notifyEvictIdle(worker);
        await worker.close("idle_timeout");
        count++;
      } else if (this.isAwaitingToolExpired(worker, now)) {
        this.workers.delete(worker);
        await worker.close("awaiting_tool_timeout");
        count++;
      }
    }
    if (count > 0) this.notifyCapacityChanged();
    return count;
  }

  closeAllSync(reason = "scheduler_shutdown"): void {
    this.shuttingDown = true;
    const allWorkers = Array.from(this.workers);
    this.workers.clear();
    for (const w of allWorkers) {
      try {
        w.closeSync(reason);
      } catch {}
    }
    this.rejectAllWaiters("Scheduler closed");
  }

  async closeAll(reason = "scheduler_shutdown"): Promise<void> {
    this.closeAllSync(reason);
  }

  destroy(): void {
    // Match `closeAllSync`: a destroyed scheduler must refuse new admissions
    // instead of silently reporting capacity it can no longer honour.
    this.shuttingDown = true;
    this.rejectAllWaiters("Scheduler closed");
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    globalActiveSchedulers.delete(this);
  }
}
