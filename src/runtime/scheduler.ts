import { BridgeHttpError, type AccountDescriptor } from "../types";
import { sweepStaleWorkspaces, type AgySessionWorker } from "./worker";

export interface GlobalSchedulerOptions {
  maxGlobalWorkers?: number;
  maxPerAccountWorkers?: number;
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  awaitingToolTimeoutMs?: number;
  installSignalHandlers?: boolean;
  onBeforeEvictIdle?: (worker: AgySessionWorker) => void;
  onReapTick?: (now: number) => void;
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
  readonly onBeforeEvictIdle?: (worker: AgySessionWorker) => void;
  onReapTick?: (now: number) => void;

  private readonly workers = new Set<AgySessionWorker>();
  private reaperTimer?: ReturnType<typeof setInterval>;
  private admissionLock: Promise<void> = Promise.resolve();

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
  }

  unregisterWorker(worker: AgySessionWorker): void {
    this.workers.delete(worker);
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

  async reserveAndRegister(worker: AgySessionWorker): Promise<void> {
    let unlockNext!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      unlockNext = resolve;
    });
    const currentLock = this.admissionLock;
    this.admissionLock = nextLock;

    try {
      await currentLock;
      await this.ensureCapacity(worker.account);
      this.registerWorker(worker);
    } finally {
      unlockNext();
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

  async ensureCapacity(account: AccountDescriptor): Promise<void> {
    const now = Date.now();
    const accountKey = `${account.accountRef}::${account.slotKey}`;

    const isAwaitingToolExpired = (w: AgySessionWorker) =>
      w.state === "AWAITING_TOOL_RESULTS" &&
      w.lastActivityAt >= 1_000_000_000 &&
      now - w.lastActivityAt >= this.awaitingToolTimeoutMs;

    // 1. Check per-account capacity
    const accountWorkers = Array.from(this.workers).filter(
      (w) =>
        `${w.account.accountRef}::${w.account.slotKey}` === accountKey &&
        w.state !== "CLOSED",
    );

    if (accountWorkers.length >= this.maxPerAccountWorkers) {
      const evictableAccountWorkers = accountWorkers
        .filter((w) => !w.pinned && (w.state === "IDLE" || isAwaitingToolExpired(w)))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

      if (evictableAccountWorkers.length === 0) {
        throw new BridgeHttpError(
          503,
          "overloaded_error",
          "All Antigravity session workers are busy or awaiting tool results",
        );
      }

      const victim = evictableAccountWorkers[0]!;
      this.workers.delete(victim);
      this.notifyEvictIdle(victim);
      await victim.close("evicted_account_lru");
    }

    // 2. Check global capacity
    const allActiveWorkers = Array.from(this.workers).filter(
      (w) => w.state !== "CLOSED",
    );

    if (allActiveWorkers.length >= this.maxGlobalWorkers) {
      const evictableWorkers = allActiveWorkers
        .filter((w) => !w.pinned && (w.state === "IDLE" || isAwaitingToolExpired(w)))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

      if (evictableWorkers.length === 0) {
        throw new BridgeHttpError(
          503,
          "overloaded_error",
          "All Antigravity session workers are busy or awaiting tool results",
        );
      }

      const victim = evictableWorkers[0]!;
      this.workers.delete(victim);
      this.notifyEvictIdle(victim);
      await victim.close("evicted_global_lru");
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
    return count;
  }

  closeAllSync(reason = "scheduler_shutdown"): void {
    const allWorkers = Array.from(this.workers);
    this.workers.clear();
    for (const w of allWorkers) {
      try {
        w.closeSync(reason);
      } catch {}
    }
  }

  async closeAll(reason = "scheduler_shutdown"): Promise<void> {
    this.closeAllSync(reason);
  }

  destroy(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    globalActiveSchedulers.delete(this);
  }
}
