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
  onBeforeEvictIdle?: (worker: AgySessionWorker) => void;
  onReapTick?: (now: number) => void;
}

const BUSY_MESSAGE =
  "All Antigravity session workers are busy or awaiting tool results";

interface CapacityWaiter {
  account: AccountDescriptor;
  workerToRegister?: AgySessionWorker;
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
  readonly onBeforeEvictIdle?: (worker: AgySessionWorker) => void;
  onReapTick?: (now: number) => void;

  private readonly workers = new Set<AgySessionWorker>();
  private readonly waiters: CapacityWaiter[] = [];
  private drainingWaiters = false;
  private drainRequested = false;
  private shuttingDown = false;
  private reaperTimer?: ReturnType<typeof setInterval>;

  constructor(options?: GlobalSchedulerOptions) {
    const envMax = process.env.AGY_BRIDGE_MAX_PROCS
      ? parseInt(process.env.AGY_BRIDGE_MAX_PROCS, 10)
      : undefined;

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
    this.onBeforeEvictIdle = options?.onBeforeEvictIdle;
    this.onReapTick = options?.onReapTick;

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
    const active = Array.from(this.workers).filter((w) => w.state !== "CLOSED");
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
    const acquired = this.tryAcquireNow(worker.account, worker);
    if (acquired.admitted) {
      await this.closeVictims(acquired.victims);
      return;
    }
    await this.waitForRoom(worker.account, worker, signal);
  }

  async ensureCapacity(
    account: AccountDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const acquired = this.tryAcquireNow(account);
    if (acquired.admitted) {
      await this.closeVictims(acquired.victims);
      return;
    }
    await this.waitForRoom(account, undefined, signal);
  }

  /** Parks the request in FIFO order until a slot frees or the bound expires. */
  private waitForRoom(
    account: AccountDescriptor,
    workerToRegister: AgySessionWorker | undefined,
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

      const removeWaiter = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };

      function onAbort(): void {
        removeWaiter();
        waiter.cleanup();
        waiter.reject(new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request aborted while waiting for session capacity",
        ));
      }

      timer = setTimeout(() => {
        removeWaiter();
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

  private notifyEvictIdle(worker: AgySessionWorker): void {
    if (worker.state === "IDLE") {
      try {
        worker.onEvict?.();
      } catch {}
      try {
        this.onBeforeEvictIdle?.(worker);
      } catch {}
    }
  }

  async evictIdleLRU(): Promise<AgySessionWorker | null> {
    const idleWorkers = Array.from(this.workers)
      .filter((w) => !w.pinned && w.state === "IDLE")
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    if (idleWorkers.length === 0) {
      return null;
    }

    const victim = idleWorkers[0]!;
    this.workers.delete(victim);
    this.notifyEvictIdle(victim);
    await victim.close("evicted_idle_lru");
    return victim;
  }

  async reapIdleWorkers(): Promise<number> {
    const now = Date.now();
    try {
      this.onReapTick?.(now);
    } catch {}
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
      } else if (
        worker.state === "AWAITING_TOOL_RESULTS" &&
        worker.lastActivityAt >= 1_000_000_000 &&
        now - worker.lastActivityAt >= this.awaitingToolTimeoutMs
      ) {
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
    this.rejectAllWaiters("Scheduler closed");
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    globalActiveSchedulers.delete(this);
  }
}
