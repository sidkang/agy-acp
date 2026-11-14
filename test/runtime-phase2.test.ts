import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type TurnStreamEvent,
} from "../src/types";
import { getPluginDataRoot } from "../src/accounts/env";
import { AgySessionWorker, type ModelSelection } from "../src/runtime/worker";
import {
  AsyncEventQueue,
  DEFAULT_MAX_TURN_QUEUE_BYTES,
} from "../src/runtime/turn-context";
import { measureProcessTreeRssBytes } from "../src/runtime/rss";
import { encodeAnthropicSseResponse } from "../src/protocol/anthropic";
import { GlobalScheduler } from "../src/runtime/scheduler";
import { SessionCoordinator } from "../src/sessions/coordinator";
import { getSharedMcpServer } from "../src/mcp/http-server";
import { spawnFakeAcp, withEnv } from "./fixtures/helpers";

const accountA: AccountDescriptor = {
  slotKey: "agy#phase2-a",
  accountRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mode: "host",
  label: "Phase2 A",
  isolatedHomeDir: null,
};

const accountB: AccountDescriptor = {
  slotKey: "agy#phase2-b",
  accountRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mode: "host",
  label: "Phase2 B",
  isolatedHomeDir: null,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MockWorker {
  account: AccountDescriptor;
  state: string;
  pinned: boolean;
  lastActivityAt: number;
  closedWith: string[];
  close: (reason?: string) => Promise<void>;
  closeSync: (reason?: string) => void;
  onEvict?: () => void;
  setSchedulerCapacityListener?: (fn: () => void) => void;
}

/**
 * Minimal scheduler double. `unpin()` mirrors the real worker's capacity hook:
 * the scheduler is told when a worker stops being pinned instead of polling.
 */
function makeMockWorker(
  account: AccountDescriptor,
  options: { state?: string; pinned?: boolean; lastActivityAt?: number } = {},
): MockWorker {
  const worker: MockWorker = {
    account,
    state: options.state ?? "GENERATING",
    pinned: options.pinned ?? true,
    lastActivityAt: options.lastActivityAt ?? Date.now(),
    closedWith: [],
    close: async (reason?: string) => {
      worker.closedWith.push(reason ?? "closed");
      worker.state = "CLOSED";
    },
    closeSync: (reason?: string) => {
      worker.closedWith.push(reason ?? "closed");
      worker.state = "CLOSED";
    },
  };
  let listener: (() => void) | undefined;
  worker.setSchedulerCapacityListener = (fn) => {
    listener = fn;
  };
  (worker as any).unpin = () => {
    worker.pinned = false;
    listener?.();
  };
  return worker;
}

describe("Phase 2 GlobalScheduler wait-for-room", () => {
  test("AGY_BRIDGE_MAX_PROCS only accepts a positive integer, otherwise the 16 default stands", async () => {
    for (const invalid of ["abc", "0", "-3"]) {
      await withEnv({ AGY_BRIDGE_MAX_PROCS: invalid }, () => {
        const scheduler = new GlobalScheduler();
        try {
          expect(scheduler.maxGlobalWorkers).toBe(16);
        } finally {
          scheduler.destroy();
        }
      });
    }

    await withEnv({ AGY_BRIDGE_MAX_PROCS: "5" }, () => {
      const scheduler = new GlobalScheduler();
      try {
        expect(scheduler.maxGlobalWorkers).toBe(5);
      } finally {
        scheduler.destroy();
      }
    });
  });

  test("parks the request and admits it as soon as a slot frees", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      const busy = makeMockWorker(accountA);
      scheduler.registerWorker(busy as any);
      expect(scheduler.getActiveCount()).toBe(1);

      const newcomer = makeMockWorker(accountA, { state: "STARTING" });
      const pending = scheduler.reserveAndRegister(newcomer as any);

      // It must be parked, not failed fast.
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await sleep(30);
      expect(settled).toBe(false);
      expect(scheduler.getActiveCount()).toBe(1);

      scheduler.unregisterWorker(busy as any);
      await pending;

      expect(scheduler.getActiveWorkers()).toContain(newcomer as any);
      expect(scheduler.getActiveCount()).toBe(1);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("a saturated account never blocks another account with free slots", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      const busyA = makeMockWorker(accountA);
      scheduler.registerWorker(busyA as any);

      const parkedA = scheduler.reserveAndRegister(
        makeMockWorker(accountA, { state: "STARTING" }) as any,
      );
      parkedA.catch(() => {});

      const startedAt = Date.now();
      const workerB = makeMockWorker(accountB, { state: "STARTING" });
      await scheduler.reserveAndRegister(workerB as any);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(scheduler.getActiveWorkers()).toContain(workerB as any);

      scheduler.unregisterWorker(busyA as any);
      await parkedA;
      expect(scheduler.getAccountWorkerCount(accountA.accountRef)).toBe(1);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("an aborted waiter fails with 499 and never registers its worker", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      const busy = makeMockWorker(accountA);
      scheduler.registerWorker(busy as any);

      const controller = new AbortController();
      const newcomer = makeMockWorker(accountA, { state: "STARTING" });
      const pending = scheduler.reserveAndRegister(newcomer as any, controller.signal);
      await sleep(20);
      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(BridgeHttpError);
      await pending.catch((err) => {
        expect((err as BridgeHttpError).status).toBe(499);
      });
      expect(scheduler.getActiveWorkers()).not.toContain(newcomer as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("a waiter that outlives the bound fails with the same 503 as before", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 40,
    });
    try {
      scheduler.registerWorker(makeMockWorker(accountA) as any);
      const pending = scheduler.reserveAndRegister(
        makeMockWorker(accountA, { state: "STARTING" }) as any,
      );
      const err = await pending.catch((e) => e);
      expect(err).toBeInstanceOf(BridgeHttpError);
      expect((err as BridgeHttpError).status).toBe(503);
      expect((err as BridgeHttpError).message).toContain(
        "overloaded",
      );
      expect((err as BridgeHttpError).message).toContain(
        "session workers are busy or awaiting tool results",
      );
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("waitTimeoutMs: 0 restores the immediate 503 and maxWaiters bounds the queue", async () => {
    const immediate = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 0,
    });
    try {
      immediate.registerWorker(makeMockWorker(accountA) as any);
      const err = await immediate
        .reserveAndRegister(makeMockWorker(accountA, { state: "STARTING" }) as any)
        .catch((e) => e);
      expect((err as BridgeHttpError).status).toBe(503);
    } finally {
      await immediate.closeAll();
      immediate.destroy();
    }

    const capped = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
      maxWaiters: 1,
    });
    try {
      capped.registerWorker(makeMockWorker(accountA) as any);
      const first = capped.reserveAndRegister(
        makeMockWorker(accountA, { state: "STARTING" }) as any,
      );
      first.catch(() => {});
      await sleep(20);
      const second = await capped
        .reserveAndRegister(makeMockWorker(accountA, { state: "STARTING" }) as any)
        .catch((e) => e);
      expect(second).toBeInstanceOf(BridgeHttpError);
      expect((second as BridgeHttpError).status).toBe(503);
    } finally {
      await capped.closeAll();
      capped.destroy();
    }
  });

  test("unpinning a worker wakes a parked waiter instead of waiting for a timeout", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      // IDLE but still pinned: not evictable until the turn releases it.
      const pinnedIdle = makeMockWorker(accountA, { state: "IDLE" });
      scheduler.registerWorker(pinnedIdle as any);

      const newcomer = makeMockWorker(accountA, { state: "STARTING" });
      const pending = scheduler.reserveAndRegister(newcomer as any);
      await sleep(20);
      expect(scheduler.getActiveWorkers()).toContain(pinnedIdle as any);

      (pinnedIdle as any).unpin();
      await pending;

      expect(pinnedIdle.closedWith).toContain("evicted_account_lru");
      expect(scheduler.getActiveWorkers()).toContain(newcomer as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("a real worker finishing a turn wakes a parked waiter through its pin release", async () => {
    const mcpServer = getSharedMcpServer();
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 4_000,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 0,
    });
    const sessionId = `phase2-pin-${Date.now()}`;
    try {
      const req: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Phase 2 pin release test",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      const turn = (async () => {
        const events: TurnStreamEvent[] = [];
        for await (const event of coordinator.executeTurn(accountA, req, {
          rawModelId: "gemini-3.8-flash",
          configModelValue: "gemini-3.8-flash",
        })) {
          events.push(event);
        }
        return events;
      })();

      // Wait until the turn owns the only slot and is pinned.
      for (let i = 0; i < 200 && scheduler.getActiveCount() !== 1; i++) {
        await sleep(10);
      }
      expect(scheduler.getActiveCount()).toBe(1);

      const waiter = makeMockWorker(accountA, { state: "STARTING" });
      const pending = scheduler.reserveAndRegister(waiter as any);
      await sleep(20);

      const events = await turn;
      expect(events.some((e) => e.type === "finish")).toBe(true);

      await pending;
      expect(scheduler.getActiveWorkers()).toContain(waiter as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
      mcpServer.stop();
    }
  }, 30_000);

  test("bare ensureCapacity fails fast with 503 when full even with waitTimeoutMs > 0, while reserveAndRegister queues", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 5_000,
    });
    try {
      const busy = makeMockWorker(accountA);
      scheduler.registerWorker(busy as any);

      const startedAt = Date.now();
      const err = await scheduler.ensureCapacity(accountA).catch((e) => e);
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(err).toBeInstanceOf(BridgeHttpError);
      expect((err as BridgeHttpError).status).toBe(503);

      const newcomer = makeMockWorker(accountA, { state: "STARTING" });
      const pending = scheduler.reserveAndRegister(newcomer as any);
      await sleep(20);
      scheduler.unregisterWorker(busy as any);
      await pending;
      expect(scheduler.getActiveWorkers()).toContain(newcomer as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("closeAll, closeAllSync, and destroy reject every parked waiter with 503", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 5_000,
    });
    scheduler.registerWorker(makeMockWorker(accountA) as any);
    const pending = scheduler.reserveAndRegister(
      makeMockWorker(accountA, { state: "STARTING" }) as any,
    );
    await sleep(20);
    await scheduler.closeAll();
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect((err as BridgeHttpError).status).toBe(503);
    scheduler.destroy();

    const syncScheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 5_000,
    });
    const busySync = makeMockWorker(accountA);
    syncScheduler.registerWorker(busySync as any);
    const syncWaiter1 = syncScheduler.reserveAndRegister(
      makeMockWorker(accountA, { state: "STARTING" }) as any,
    );
    const syncWaiter2 = syncScheduler.reserveAndRegister(
      makeMockWorker(accountA, { state: "STARTING" }) as any,
    );
    await sleep(20);
    syncScheduler.closeAllSync("test_sync_shutdown");
    const [e1, e2] = await Promise.all([
      syncWaiter1.catch((e) => e),
      syncWaiter2.catch((e) => e),
    ]);
    expect(e1).toBeInstanceOf(BridgeHttpError);
    expect((e1 as BridgeHttpError).status).toBe(503);
    expect(e2).toBeInstanceOf(BridgeHttpError);
    expect((e2 as BridgeHttpError).status).toBe(503);
    expect(busySync.closedWith).toContain("test_sync_shutdown");
    syncScheduler.destroy();

    const destroyScheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 5_000,
    });
    destroyScheduler.registerWorker(makeMockWorker(accountA) as any);
    const destroyWaiter = destroyScheduler.reserveAndRegister(
      makeMockWorker(accountA, { state: "STARTING" }) as any,
    );
    await sleep(20);
    destroyScheduler.destroy();
    const destroyErr = await destroyWaiter.catch((e) => e);
    expect(destroyErr).toBeInstanceOf(BridgeHttpError);
    expect((destroyErr as BridgeHttpError).status).toBe(503);

    // Subsequent reserveAndRegister after destroy() must reject immediately with 503 "Scheduler closed".
    const postDestroyErr = await destroyScheduler
      .reserveAndRegister(makeMockWorker(accountA, { state: "STARTING" }) as any)
      .catch((e) => e);
    expect(postDestroyErr).toBeInstanceOf(BridgeHttpError);
    expect((postDestroyErr as BridgeHttpError).status).toBe(503);
    expect((postDestroyErr as BridgeHttpError).message).toBe("Scheduler closed");
  });

  test("pin-ordering under saturation: failed warm turn retires before unpinning and never shelves failed session", async () => {
    const mcpServer = getSharedMcpServer();
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 4_000,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 0,
    });
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };
    const sessionA = `phase2-fail-pin-a-${Date.now()}`;
    const sessionB = `phase2-fail-pin-b-${Date.now()}`;
    const sessionKeyA = `${accountA.slotKey}::${accountA.accountRef}::${sessionA}`;
    const parkedFile = path.join(getPluginDataRoot(), "parked-sessions.json");

    try {
      // 1. Establish warm session A.
      const reqA1: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Pin ordering failed turn test",
        messages: [{ role: "user", content: [{ type: "text", text: "warm up A" }] }],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId: sessionA,
      };
      let answerA1 = "";
      for await (const ev of coordinator.executeTurn(accountA, reqA1, sel)) {
        if (ev.type === "text_delta") answerA1 += ev.text;
      }
      const workerA = coordinator.getActiveWorker(sessionKeyA)!;
      expect(workerA).toBeDefined();
      const failedNativeId = workerA.nativeSessionId;
      expect(failedNativeId).toBeTruthy();

      // 2. Start Turn 2 on session A that emits an { type: "error" } event while pinned.
      const reqA2: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Pin ordering failed turn test",
        messages: [
          { role: "user", content: [{ type: "text", text: "warm up A" }] },
          { role: "assistant", content: [{ type: "text", text: answerA1 }] },
          { role: "user", content: [{ type: "text", text: "TRIGGER_ERROR_TERMINATION" }] },
        ],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId: sessionA,
      };
      const iterA2 = coordinator.executeTurn(accountA, reqA2, sel);
      const firstA2 = iterA2.next();

      // Synchronously queue session B behind pinned workerA in GlobalScheduler.
      let bSettled = false;
      const reqB1: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Pin ordering failed turn test",
        messages: [{ role: "user", content: [{ type: "text", text: "hello B" }] }],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId: sessionB,
      };
      const turnB = (async () => {
        const events: TurnStreamEvent[] = [];
        for await (const ev of coordinator.executeTurn(accountA, reqB1, sel)) {
          events.push(ev);
        }
        bSettled = true;
        return events;
      })();

      // Drain A2 (emits { type: "error" }) -> retires A before unpinning -> wakes B.
      const eventsA2: TurnStreamEvent[] = [];
      const firstRes = await firstA2;
      if (!firstRes.done) eventsA2.push(firstRes.value);
      for (;;) {
        const step = await iterA2.next();
        if (step.done) break;
        eventsA2.push(step.value);
      }
      expect(eventsA2.some((e) => e.type === "error")).toBe(true);
      expect(workerA.closed).toBe(true);

      const eventsB = await turnB;
      expect(bSettled).toBe(true);
      expect(eventsB.some((e) => e.type === "finish")).toBe(true);

      // Session A must NOT be shelved in memory or on disk.
      expect(coordinator.shelf.memorySessions.has(sessionKeyA)).toBe(false);
      if (fs.existsSync(parkedFile)) {
        const persisted = JSON.parse(fs.readFileSync(parkedFile, "utf8"));
        expect(persisted?.sessions?.[sessionKeyA]).toBeUndefined();
      }

      // 3. Subsequent Turn 3 on session A cold-starts a fresh native session instead of resuming failedNativeId.
      const reqA3: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Pin ordering failed turn test",
        messages: [
          { role: "user", content: [{ type: "text", text: "warm up A" }] },
          { role: "assistant", content: [{ type: "text", text: answerA1 }] },
          { role: "user", content: [{ type: "text", text: "INSPECT_RESUME fresh A" }] },
        ],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId: sessionA,
      };
      let answerA3 = "";
      for await (const ev of coordinator.executeTurn(accountA, reqA3, sel)) {
        if (ev.type === "text_delta") answerA3 += ev.text;
      }
      const workerA3 = coordinator.getActiveWorker(sessionKeyA)!;
      expect(workerA3).toBeDefined();
      expect(workerA3.resumedFromShelf).toBe(false);
      expect(workerA3.nativeSessionId).not.toBe(failedNativeId);
      expect(answerA3).not.toContain(`[resumedSessionId=${failedNativeId}]`);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
      mcpServer.stop();
    }
  }, 30_000);

  test("admits multiple waiters on the same saturated account in strict FIFO order", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      const busy0 = makeMockWorker(accountA);
      scheduler.registerWorker(busy0 as any);

      const order: number[] = [];
      const w1 = makeMockWorker(accountA, { state: "STARTING" });
      const w2 = makeMockWorker(accountA, { state: "STARTING" });
      const w3 = makeMockWorker(accountA, { state: "STARTING" });

      const p1 = scheduler.reserveAndRegister(w1 as any).then(() => order.push(1));
      const p2 = scheduler.reserveAndRegister(w2 as any).then(() => order.push(2));
      const p3 = scheduler.reserveAndRegister(w3 as any).then(() => order.push(3));

      await sleep(20);
      expect(order).toEqual([]);

      scheduler.unregisterWorker(busy0 as any);
      await p1;
      await sleep(15);
      expect(order).toEqual([1]);
      expect(scheduler.getActiveWorkers()).toContain(w1 as any);

      scheduler.unregisterWorker(w1 as any);
      await p2;
      await sleep(15);
      expect(order).toEqual([1, 2]);
      expect(scheduler.getActiveWorkers()).toContain(w2 as any);

      scheduler.unregisterWorker(w2 as any);
      await p3;
      expect(order).toEqual([1, 2, 3]);
      expect(scheduler.getActiveWorkers()).toContain(w3 as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });

  test("aborting one waiter rejects promptly with 499 and passes the next release to the next live waiter", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      waitTimeoutMs: 4_000,
    });
    try {
      const busy = makeMockWorker(accountA);
      scheduler.registerWorker(busy as any);

      // Already-aborted signal fails immediately with 499.
      const preAborted = new AbortController();
      preAborted.abort();
      const preErr = await scheduler
        .reserveAndRegister(
          makeMockWorker(accountA, { state: "STARTING" }) as any,
          preAborted.signal,
        )
        .catch((e) => e);
      expect(preErr).toBeInstanceOf(BridgeHttpError);
      expect((preErr as BridgeHttpError).status).toBe(499);

      const ctrl1 = new AbortController();
      const w1 = makeMockWorker(accountA, { state: "STARTING" });
      const w2 = makeMockWorker(accountA, { state: "STARTING" });

      const p1 = scheduler.reserveAndRegister(w1 as any, ctrl1.signal);
      let p2Resolved = false;
      const p2 = scheduler.reserveAndRegister(w2 as any).then(() => {
        p2Resolved = true;
      });

      await sleep(20);
      const abortAt = Date.now();
      ctrl1.abort();

      const err1 = await p1.catch((e) => e);
      expect(Date.now() - abortAt).toBeLessThan(500);
      expect(err1).toBeInstanceOf(BridgeHttpError);
      expect((err1 as BridgeHttpError).status).toBe(499);
      expect(scheduler.getActiveWorkers()).not.toContain(w1 as any);
      expect(p2Resolved).toBe(false);

      // Releasing the busy worker now wakes w2 cleanly.
      scheduler.unregisterWorker(busy as any);
      await p2;
      expect(p2Resolved).toBe(true);
      expect(scheduler.getActiveWorkers()).toContain(w2 as any);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });
});

describe("Phase 2 bounded turn event queue (MED-4)", () => {
  test("16 MiB is the default ceiling", () => {
    expect(DEFAULT_MAX_TURN_QUEUE_BYTES).toBe(16 * 1024 * 1024);
  });

  test("a stalled consumer fails the turn with a 502 instead of buffering forever", async () => {
    const overflows: BridgeHttpError[] = [];
    const queue = new AsyncEventQueue<any>({
      maxBufferedBytes: 100,
      estimateBytes: () => 60,
      onOverflow: (err) => overflows.push(err),
    });

    queue.push({ type: "text_delta", text: "one" });
    expect(queue.pendingBytes).toBe(60);
    queue.push({ type: "text_delta", text: "two" });

    expect(overflows).toHaveLength(1);
    expect(overflows[0]!.status).toBe(502);
    expect(queue.pendingBytes).toBe(0);
    await expect(queue.next()).rejects.toBeInstanceOf(BridgeHttpError);
  });

  test("items handed straight to a waiting reader never count against the cap", async () => {
    const overflows: any[] = [];
    const queue = new AsyncEventQueue<any>({
      maxBufferedBytes: 100,
      estimateBytes: () => 60,
      onOverflow: (err) => overflows.push(err),
    });

    const reader = queue.next();
    queue.push({ type: "text_delta", text: "direct" });
    const first = await reader;
    expect(first.done).toBe(false);
    expect(queue.pendingBytes).toBe(0);
    expect(overflows).toHaveLength(0);

    // Only once the reader stops pulling does the buffer start to count.
    queue.push({ type: "text_delta", text: "a" });
    expect(queue.pendingBytes).toBe(60);
    queue.push({ type: "text_delta", text: "b" });
    expect(overflows).toHaveLength(1);
  });

  test("close() still drains already-buffered events before signalling done", async () => {
    const queue = new AsyncEventQueue<any>({ maxBufferedBytes: 1024 });
    queue.push({ type: "text_delta", text: "kept" });
    queue.close();

    const first = await queue.next();
    expect(first).toEqual({ value: { type: "text_delta", text: "kept" }, done: false });
    const second = await queue.next();
    expect(second.done).toBe(true);
  });

  test("AgySessionWorker onOverflow tears down the worker and rejects the stalled consumer with 502", async () => {
    const mcpServer = getSharedMcpServer();
    const worker = new AgySessionWorker(accountA, `phase2-overflow-${Date.now()}`, mcpServer, {
      spawnFn: spawnFakeAcp,
      // 100 bytes allows the first text_delta to be consumed via active waiter,
      // then overflows when finish (128 bytes) arrives with no reader pulling.
      maxTurnBufferBytes: 100,
    });
    try {
      await worker.start();
      const iter = worker.startPromptTurn([{ type: "text", text: "hi" }]);

      // Pull the first event so the turn begins and the reader stops afterwards.
      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe("text_delta");

      // Wait for fake-acp's session/prompt response (finish = 128B > 100B) to overflow.
      for (let i = 0; i < 100 && !worker.closed; i++) {
        await sleep(10);
      }
      expect(worker.closed).toBe(true);
      expect(worker.state).toBe("CLOSED");

      const nextErr = await iter.next().catch((e) => e);
      expect(nextErr).toBeInstanceOf(BridgeHttpError);
      expect((nextErr as BridgeHttpError).status).toBe(502);
    } finally {
      await worker.close("test_cleanup");
      mcpServer.stop();
    }
  }, 15_000);

  test("AgySessionWorker handlePromptError queue overflow causes no unhandled TypeError and closes cleanly with 502", async () => {
    const mcpServer = getSharedMcpServer();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const inlineErrorAcp = [
      'import readline from "node:readline";',
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });",
      'const send = (d) => process.stdout.write(JSON.stringify(d) + "\\n");',
      'rl.on("line", (line) => {',
      "  const m = JSON.parse(line);",
      '  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });',
      '  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "err-overflow-sess" } });',
      '  if (m.method === "session/prompt") {',
      '    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "err-overflow-sess", update: { sessionUpdate: "agent_message_chunk", content: { text: "first" } } } });',
      '    setTimeout(() => send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "prompt exploded" } }), 15);',
      "  }",
      "});",
    ].join("\n");

    const worker = new AgySessionWorker(
      accountA,
      `phase2-err-overflow-${Date.now()}`,
      mcpServer,
      {
        maxTurnBufferBytes: 64,
        spawnFn: () =>
          spawn("bun", ["-e", inlineErrorAcp], {
            stdio: ["pipe", "pipe", "pipe"],
          }),
      },
    );
    try {
      await worker.start();
      const iter = worker.startPromptTurn([{ type: "text", text: "go" }]);

      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe("text_delta");

      // Let the prompt error arrive before the consumer pulls a second time;
      // the ~128B error event overflows maxTurnBufferBytes (64B) inside handlePromptError.
      for (let i = 0; i < 100 && !worker.closed; i++) {
        await sleep(10);
      }
      expect(worker.closed).toBe(true);
      expect(worker.state).toBe("CLOSED");

      const nextErr = await iter.next().catch((e) => e);
      expect(nextErr).toBeInstanceOf(BridgeHttpError);
      expect((nextErr as BridgeHttpError).status).toBe(502);
      expect((nextErr as BridgeHttpError).message).toContain(
        "Agent stream buffer exceeded maximum capacity due to slow consumer",
      );
      await sleep(20);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await worker.close("test_cleanup");
      mcpServer.stop();
    }
  }, 15_000);

  test("encodeAnthropicSseResponse heartbeat does not accumulate ping frames when reader stops pulling", async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const heartbeats: Array<() => void> = [];
    let cleared = 0;

    globalThis.setInterval = ((callback: () => void) => {
      heartbeats.push(callback);
      return 1 as unknown as ReturnType<typeof realSetInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as unknown as typeof clearInterval;

    try {
      // Case 1: Reader pulls message_start, then stops pulling while heartbeat fires 50 times.
      let release1: () => void = () => {};
      const gate1 = new Promise<void>((resolve) => {
        release1 = resolve;
      });
      async function* silentAfterFirst(): AsyncGenerator<TurnStreamEvent> {
        yield { type: "text_delta", text: "hello" };
        await gate1;
        yield {
          type: "finish",
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      }

      const res1 = await encodeAnthropicSseResponse("gemini-3.8-flash", silentAfterFirst());
      const reader1 = res1.body!.getReader();
      const firstChunk = await reader1.read();
      expect(firstChunk.done).toBe(false);

      for (let i = 0; i < 20 && heartbeats.length === 0; i++) {
        await sleep(5);
      }
      expect(heartbeats.length).toBe(1);

      // Reader has stopped pulling (highWaterMark: 0 -> desiredSize <= 0, pullCredits === 0).
      for (let i = 0; i < 50; i++) {
        heartbeats[0]!();
      }

      release1();
      const decoder = new TextDecoder();
      let payload1 = decoder.decode(firstChunk.value);
      for (;;) {
        const next = await reader1.read();
        if (next.done) break;
        payload1 += decoder.decode(next.value);
      }
      const pingMatches1 = payload1.match(/^event: ping$/gm) ?? [];
      expect(pingMatches1.length).toBe(0);

      // Case 2: Reader has 1 pending read waiting while upstream is silent and heartbeat fires 50 times:
      // at most 1 ping consumes that pending pullCredit, never 50.
      heartbeats.length = 0;
      let release2: () => void = () => {};
      const gate2 = new Promise<void>((resolve) => {
        release2 = resolve;
      });
      async function* silentAfterSecond(): AsyncGenerator<TurnStreamEvent> {
        yield { type: "text_delta", text: "wait" };
        await gate2;
        yield {
          type: "finish",
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      }

      const res2 = await encodeAnthropicSseResponse("gemini-3.8-flash", silentAfterSecond());
      const reader2 = res2.body!.getReader();
      let payload2 = "";
      // Drain initial peeked frames (message_start, content_block_start, content_block_delta)
      for (let i = 0; i < 3; i++) {
        const chunk = await reader2.read();
        if (!chunk.done && chunk.value) payload2 += decoder.decode(chunk.value);
      }
      // Issue one pending read (grants 1 pullCredit), then stop pulling.
      const pendingRead = reader2.read();
      await sleep(10);
      expect(heartbeats.length).toBe(1);
      for (let i = 0; i < 50; i++) {
        heartbeats[0]!();
      }
      const pingChunk = await pendingRead;
      if (!pingChunk.done && pingChunk.value) {
        payload2 += decoder.decode(pingChunk.value);
      }
      release2();
      for (;;) {
        const next = await reader2.read();
        if (next.done) break;
        payload2 += decoder.decode(next.value);
      }
      const pingMatches2 = payload2.match(/^event: ping$/gm) ?? [];
      expect(pingMatches2.length).toBe(1);
      expect(cleared).toBe(2);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});

describe("Phase 2 single-process ACP mode", () => {
  const mcpServer = getSharedMcpServer();

  afterAll(() => {
    mcpServer.stop();
  });

  test("spawns agy with --worker and --disable-telemetry, and without --process-per-session", async () => {
    const captured: string[][] = [];
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 2,
      maxPerAccountWorkers: 2,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: (account: AccountDescriptor, args: string[], opts?: any) => {
        captured.push([...args]);
        return spawnFakeAcp(account, args, opts);
      },
      maxWorkerRssBytes: 0,
    });
    const sessionId = `phase2-flags-${Date.now()}`;
    const history: any[] = [];
    try {
      const events: TurnStreamEvent[] = [];
      const req: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Phase 2 flags test",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      history.push({ role: "user", content: [{ type: "text", text: "hi" }] });
      for await (const event of coordinator.executeTurn(accountA, req, {
        rawModelId: "gemini-3.8-flash",
        configModelValue: "gemini-3.8-flash",
      })) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "finish")).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("--worker");
      expect(captured[0]).toContain("--disable-telemetry");
      expect(captured[0]).not.toContain("--process-per-session");
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);
});

describe("Phase 2 post-turn RSS recycling", () => {
  const mcpServer = getSharedMcpServer();

  afterAll(() => {
    mcpServer.stop();
  });

  /**
   * Magpie replays the full conversation every turn, so the fake-history here
   * must accumulate exactly like a real client or the warm reuse path is never
   * exercised (the coordinator would retire on diverged history).
   */
  type History = Array<{
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string }>;
  }>;

  function turnRequest(
    sessionId: string,
    history: History,
    text: string,
  ): NormalizedAnthropicRequest {
    history.push({ role: "user", content: [{ type: "text", text }] });
    return {
      model: "gemini-3.8-flash",
      system: "Phase 2 RSS test",
      messages: history.map((m) => ({ role: m.role, content: [...m.content] })),
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
  }

  /**
   * Runs one turn with a replayed history, then appends the assistant reply so
   * the next request is byte-compatible with the committed ledger.
   */
  async function runTurn(
    coordinator: SessionCoordinator,
    sessionId: string,
    history: History,
    text: string,
    options?: any,
  ): Promise<TurnStreamEvent[]> {
    const events = await drain(
      coordinator,
      turnRequest(sessionId, history, text),
      options,
    );
    const answer = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text as string)
      .join("");
    history.push({ role: "assistant", content: [{ type: "text", text: answer }] });
    return events;
  }

  const selection: ModelSelection = {
    rawModelId: "gemini-3.8-flash",
    configModelValue: "gemini-3.8-flash",
  };

  async function drain(
    coordinator: SessionCoordinator,
    req: NormalizedAnthropicRequest,
    options?: any,
  ): Promise<TurnStreamEvent[]> {
    const events: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(accountA, req, selection, options)) {
      events.push(event);
    }
    return events;
  }

  test("a clean turn above the ceiling parks the session and the next turn resumes a new process", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 4,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 1_000,
    });
    const sessionId = `phase2-rss-${Date.now()}`;
    const history: History = [];
    try {
      let currentRss = 2_000;
      let capturedNativeId = "";
      let firstWorkerRef: any = null;

      // Capture worker reference & nativeSessionId right before turn 1 finishes/retires.
      const turn1Events: TurnStreamEvent[] = [];
      const req1 = turnRequest(sessionId, history, "remember the token");
      for await (const event of coordinator.executeTurn(accountA, req1, selection, {
        measureRssBytes: () => currentRss,
      })) {
        if (!firstWorkerRef) {
          const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
          firstWorkerRef = coordinator.getActiveWorker(sessionKey);
          if (firstWorkerRef?.nativeSessionId) {
            capturedNativeId = firstWorkerRef.nativeSessionId;
          }
        }
        turn1Events.push(event);
      }
      const answer1 = turn1Events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text as string)
        .join("");
      history.push({ role: "assistant", content: [{ type: "text", text: answer1 }] });
      expect(turn1Events.some((e) => e.type === "finish")).toBe(true);
      expect(capturedNativeId).not.toBe("");
      expect(firstWorkerRef.closed).toBe(true);

      const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
      // Over the ceiling: the worker was parked and its process closed.
      expect(coordinator.getActiveWorker(sessionKey)).toBeUndefined();

      currentRss = 10;
      const turn2 = await runTurn(coordinator, sessionId, history, "INSPECT_RESUME what was the token?", {
        measureRssBytes: () => currentRss,
      });
      expect(turn2.some((e) => e.type === "finish")).toBe(true);
      const answer2 = turn2
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text as string)
        .join("");
      // fake-acp echoes [resumedSessionId=<id>] proving session/resume used turn 1's nativeSessionId.
      expect(answer2).toContain(`[resumedSessionId=${capturedNativeId}]`);

      const resumedWorker = coordinator.getActiveWorker(sessionKey);
      expect(resumedWorker).toBeDefined();
      expect(resumedWorker).not.toBe(firstWorkerRef);
      expect(resumedWorker!.resumedFromShelf).toBe(true);
      expect(resumedWorker!.nativeSessionId).toBe(capturedNativeId);
      expect(resumedWorker!.closed).toBe(false);
      // Full ledger continuity: 2 user + 2 assistant turns committed.
      expect(resumedWorker!.committedMessages.length).toBe(4);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);

  test("high RSS while AWAITING_TOOL_RESULTS does NOT recycle mid-tool-chain; recycles once IDLE", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 4,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 1_000,
    });
    const sessionId = `phase2-rss-tools-${Date.now()}`;
    const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
    const tools = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    let currentRss = 2_000;
    try {
      // Turn 1: high RSS, ends in tool_use (state === AWAITING_TOOL_RESULTS).
      const req1: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Phase 2 RSS tool test",
        messages: [
          { role: "user", content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }] },
        ],
        tools,
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      const turn1Events = await drain(coordinator, req1, {
        measureRssBytes: () => currentRss,
      });
      const toolUse = turn1Events.find((e) => e.type === "tool_use") as any;
      expect(toolUse).toBeDefined();
      const finish1 = turn1Events.find((e) => e.type === "finish") as any;
      expect(finish1?.stopReason).toBe("tool_use");

      // Worker MUST stay alive in AWAITING_TOOL_RESULTS despite RSS > maxWorkerRssBytes.
      const worker1 = coordinator.getActiveWorker(sessionKey);
      expect(worker1).toBeDefined();
      expect(worker1!.closed).toBe(false);
      expect(worker1!.state).toBe("AWAITING_TOOL_RESULTS");
      const nativeId = worker1!.nativeSessionId;

      // Turn 2: deliver tool_result while RSS is still above ceiling.
      const req2: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Phase 2 RSS tool test",
        messages: [
          { role: "user", content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUse.id,
                name: toolUse.name,
                input: toolUse.input,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: toolUse.id,
                content: [{ type: "text", text: "68F sunny" }],
                isError: false,
              },
            ],
          },
        ],
        tools,
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      const turn2Events = await drain(coordinator, req2, {
        measureRssBytes: () => currentRss,
      });
      const answer2 = turn2Events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text as string)
        .join("");
      expect(answer2).toContain("68F sunny");
      const finish2 = turn2Events.find((e) => e.type === "finish") as any;
      expect(finish2?.stopReason).toBe("end_turn");

      // Now that the turn completed cleanly in IDLE with high RSS, worker1 is parked and retired.
      expect(worker1!.closed).toBe(true);
      expect(coordinator.getActiveWorker(sessionKey)).toBeUndefined();

      // Turn 3: next turn resumes seamlessly with full ledger continuity.
      currentRss = 10;
      const req3: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "Phase 2 RSS tool test",
        messages: [
          ...req2.messages,
          { role: "assistant", content: [{ type: "text", text: answer2 }] },
          { role: "user", content: [{ type: "text", text: "INSPECT_RESUME follow up" }] },
        ],
        tools,
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      const turn3Events = await drain(coordinator, req3, {
        measureRssBytes: () => currentRss,
      });
      const answer3 = turn3Events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text as string)
        .join("");
      expect(answer3).toContain(`[resumedSessionId=${nativeId}]`);
      const resumed = coordinator.getActiveWorker(sessionKey);
      expect(resumed).toBeDefined();
      expect(resumed!.resumedFromShelf).toBe(true);
      expect(resumed!.nativeSessionId).toBe(nativeId);
      expect(resumed!.committedMessages.length).toBe(6);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);

  test("a worker under the ceiling is reused warm and never closed", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 4,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 1_000_000,
    });
    const sessionId = `phase2-rss-low-${Date.now()}`;
    const history: History = [];
    try {
      await runTurn(coordinator, sessionId, history, "hello", {
        measureRssBytes: () => 10,
      });
      const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
      const firstWorker = coordinator.getActiveWorker(sessionKey);
      expect(firstWorker).toBeDefined();
      expect(firstWorker!.closed).toBe(false);

      await runTurn(coordinator, sessionId, history, "again", {
        measureRssBytes: () => 10,
      });
      const secondWorker = coordinator.getActiveWorker(sessionKey);
      expect(secondWorker).toBe(firstWorker);
      expect(secondWorker!.resumedFromShelf).toBe(false);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);

  test("maxWorkerRssBytes: 0 disables recycling entirely", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 4,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 0,
    });
    const sessionId = `phase2-rss-off-${Date.now()}`;
    const history: History = [];
    try {
      await runTurn(coordinator, sessionId, history, "first", {
        measureRssBytes: () => 10 * 1024 * 1024 * 1024,
      });
      const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
      const firstWorker = coordinator.getActiveWorker(sessionKey);
      expect(firstWorker).toBeDefined();
      expect(firstWorker!.closed).toBe(false);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);

  test("oversized (>4 MiB) seeded session skips RSS recycling and reuses live warm worker in place", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 4,
      maxPerAccountWorkers: 4,
      idleTimeoutMs: 60_000,
      waitTimeoutMs: 0,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer,
      spawnFn: spawnFakeAcp,
      maxWorkerRssBytes: 1_000,
    });
    const sessionId = `phase2-rss-seeded-oversized-${Date.now()}`;
    const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
    // 90 prior messages x 50 KiB = 4.5 MiB (> 4 MiB MAX_SINGLE_PARKED_BYTES,
    // and > 112 KiB prompt budget so prior history spills into systemHistorySeed).
    const chunk = "S".repeat(50 * 1024);
    const history: History = [];
    for (let i = 0; i < 45; i++) {
      history.push(
        { role: "user", content: [{ type: "text", text: `q-${i}-${chunk}` }] },
        { role: "assistant", content: [{ type: "text", text: `a-${i}-${chunk}` }] },
      );
    }

    try {
      const turn1 = await runTurn(coordinator, sessionId, history, "current turn", {
        measureRssBytes: () => 2_000,
      });
      expect(turn1.some((e) => e.type === "finish")).toBe(true);

      // Must NOT recycle for RSS because the seeded >4 MiB session cannot be shelved.
      expect(scheduler.getActiveCount()).toBe(1);
      const worker1 = coordinator.getActiveWorker(sessionKey);
      expect(worker1).toBeDefined();
      expect(worker1!.appliedSystemHistorySeed).toBeTruthy();
      expect(worker1!.closed).toBe(false);

      // Next turn reuses the live warm worker in place.
      const turn2 = await runTurn(coordinator, sessionId, history, "warm follow up", {
        measureRssBytes: () => 2_000,
      });
      expect(turn2.some((e) => e.type === "finish")).toBe(true);
      expect(scheduler.getActiveCount()).toBe(1);
      const worker2 = coordinator.getActiveWorker(sessionKey);
      expect(worker2).toBe(worker1);
      expect(worker2!.resumedFromShelf).toBe(false);
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  }, 30_000);
});

describe("Phase 2 RSS measurement (src/runtime/rss.ts)", () => {
  test("measureProcessTreeRssBytes samples a live process tree and returns 0 for invalid pids", () => {
    expect(measureProcessTreeRssBytes(0)).toBe(0);
    expect(measureProcessTreeRssBytes(-5)).toBe(0);
    expect(measureProcessTreeRssBytes(1)).toBe(0);
    expect(measureProcessTreeRssBytes(999_999_999)).toBe(0);
    if (process.platform !== "win32") {
      expect(measureProcessTreeRssBytes(process.pid)).toBeGreaterThan(0);
    }
  });
});
