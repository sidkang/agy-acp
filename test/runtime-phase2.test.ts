import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type TurnStreamEvent,
} from "../src/types";
import {
  AsyncEventQueue,
  DEFAULT_MAX_TURN_QUEUE_BYTES,
  type ModelSelection,
} from "../src/runtime/worker";
import { GlobalScheduler } from "../src/runtime/scheduler";
import { SessionCoordinator } from "../src/sessions/coordinator";
import { getSharedMcpServer } from "../src/mcp/http-server";

const fakeAcpPath = path.resolve(__dirname, "fixtures/fake-acp.ts");

function spawnFakeAcp(account: AccountDescriptor, args: string[], opts?: any) {
  return spawn("bun", ["run", fakeAcpPath], {
    cwd: opts?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

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
        "All Antigravity session workers are busy or awaiting tool results",
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

  test("closeAll rejects every parked waiter so none is left hanging", async () => {
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
});

describe("Phase 2 single-process ACP mode", () => {
  const mcpServer = getSharedMcpServer();

  afterAll(() => {
    mcpServer.stop();
  });

  test("spawns agy with --disable-telemetry and without --process-per-session", async () => {
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
      const turn1 = await runTurn(coordinator, sessionId, history, "remember the token", {
        measureRssBytes: () => 2_000,
      });
      expect(turn1.some((e) => e.type === "finish")).toBe(true);

      const sessionKey = `${accountA.slotKey}::${accountA.accountRef}::${sessionId}`;
      // Over the ceiling: the worker was parked and its process closed.
      expect(coordinator.getActiveWorker(sessionKey)).toBeUndefined();

      const turn2 = await runTurn(coordinator, sessionId, history, "what was the token?", {
        measureRssBytes: () => 10,
      });
      expect(turn2.some((e) => e.type === "finish")).toBe(true);

      const resumedWorker = coordinator.getActiveWorker(sessionKey);
      expect(resumedWorker).toBeDefined();
      expect(resumedWorker!.resumedFromShelf).toBe(true);
      expect(resumedWorker!.closed).toBe(false);
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
});
