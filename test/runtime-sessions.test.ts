import { describe, expect, test, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type TurnStreamEvent,
} from "../src/types";
import { AcpConnection } from "../src/runtime/acp-connection";
import { GlobalScheduler } from "../src/runtime/scheduler";
import {
  AgySessionWorker,
  createSyntheticThinkingSignature,
  type ModelSelection,
} from "../src/runtime/worker";
import { SessionCoordinator } from "../src/sessions/coordinator";
import { getSharedMcpServer } from "../src/mcp/http-server";

const fakeAcpPath = path.resolve(__dirname, "fixtures/fake-acp.ts");

function spawnFakeAcp(account: AccountDescriptor, args: string[], opts?: any) {
  return spawn("bun", ["run", fakeAcpPath], {
    cwd: opts?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const testAccount: AccountDescriptor = {
  slotKey: "agy#test1",
  accountRef: "11111111-1111-4111-8111-111111111111",
  mode: "host",
  label: "Test Account",
  isolatedHomeDir: null,
};

describe("AcpConnection", () => {
  test("exchanges JSON-RPC requests and notifications with fake ACP", async () => {
    const child = spawn("bun", ["run", fakeAcpPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const conn = new AcpConnection(child);

    const initRes: any = await conn.request("initialize", {
      protocolVersion: 1,
    });
    expect(initRes.protocolVersion).toBe(1);
    expect(initRes.agentCapabilities.promptCapabilities.image).toBe(true);

    const updates: any[] = [];
    const unsub = conn.onSessionUpdate((p) => updates.push(p));

    const sessRes: any = await conn.request("session/new", {
      mcpServers: [{ name: "magpie", type: "http", url: "http://127.0.0.1:9999" }],
    });
    expect(sessRes.sessionId).toBeDefined();

    const promptRes: any = await conn.request("session/prompt", {
      sessionId: sessRes.sessionId,
      prompt: "Hello world",
    });

    expect(promptRes.usage.inputTokens).toBeGreaterThan(0);
    expect(updates.length).toBeGreaterThan(0);

    unsub();
    conn.close();
    child.kill();
  });

  test("captures bounded stderr in ring buffer up to 16 KiB", () => {
    const child = spawn("cat", {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const conn = new AcpConnection(child);
    const chunk = "A".repeat(1024);
    for (let i = 0; i < 20; i++) {
      child.stderr.emit("data", Buffer.from(chunk));
    }

    const tail = conn.getStderrTail();
    expect(tail.length).toBe(16 * 1024);
    conn.close();
    child.kill();
  });

  test("handles server-initiated session/request_permission with deny", async () => {
    const child = spawn("bun", ["run", fakeAcpPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const conn = new AcpConnection(child);
    await conn.request("initialize", { protocolVersion: 1 });
    const sessRes: any = await conn.request("session/new", {
      mcpServers: [{ name: "magpie", type: "http", url: "http://127.0.0.1:9999" }],
    });

    const promptRes: any = await conn.request("session/prompt", {
      sessionId: sessRes.sessionId,
      prompt: "TRIGGER_PERMISSION_REQUEST",
    });

    expect(promptRes.permissionOutcome).toBeDefined();
    expect(
      promptRes.permissionOutcome?.outcome === "deny" ||
      promptRes.permissionOutcome?.optionId === "deny"
    ).toBe(true);

    conn.close();
    child.kill();
  });
});

describe("Runtime Sessions & Coordinator Integration", () => {
  const mcpServer = getSharedMcpServer();
  const scheduler = new GlobalScheduler({
    maxGlobalWorkers: 4,
    maxPerAccountWorkers: 2,
    idleTimeoutMs: 60_000,
  });

  const coordinator = new SessionCoordinator({
    scheduler,
    mcpServer,
    spawnFn: spawnFakeAcp,
  });

  afterAll(async () => {
    await scheduler.closeAll();
    scheduler.destroy();
    mcpServer.stop();
  });

  test("1. Multi-turn warm session reuse + mid-session model/effort switch", async () => {
    const sessionId = `test-sess-${Date.now()}`;
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "System prompt test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Turn 1 user message" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel1: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
      effort: "low",
    };

    const events1: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req1, sel1)) {
      events1.push(event);
    }

    const finish1 = events1.find((e) => e.type === "finish");
    expect(finish1).toBeDefined();
    expect(finish1?.type === "finish" && finish1.stopReason).toBe("end_turn");

    const text1 = events1
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text1).toContain("model=gemini-3.8-flash");
    expect(text1).toContain("effort=low");

    // Turn 2 on same session with model/effort switch
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-4-hydrogen",
      system: "System prompt test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Turn 1 user message" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: text1 }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Turn 2 user message" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel2: ModelSelection = {
      rawModelId: "gemini-4-hydrogen",
      configModelValue: "gemini-4-hydrogen",
      effort: "high",
    };

    const events2: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req2, sel2)) {
      events2.push(event);
    }

    const finish2 = events2.find((e) => e.type === "finish");
    expect(finish2).toBeDefined();
    expect(finish2?.type === "finish" && finish2.stopReason).toBe("end_turn");

    const text2 = events2
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text2).toContain("model=gemini-4-hydrogen");
    expect(text2).toContain("effort=high");
  });

  test("2. Cross-HTTP-turn MCP tool parking and continuation", async () => {
    const sessionId = `test-tool-sess-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Get weather for a location",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];

    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Tool system prompt",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please TRIGGER_TOOL_CALL" }],
        },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    // Turn 1
    const events1: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req1, sel)) {
      events1.push(event);
    }

    const toolUse = events1.find((e) => e.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.type === "tool_use" && toolUse.name).toBe("get_weather");

    const finish1 = events1.find((e) => e.type === "finish");
    expect(finish1?.type === "finish" && finish1.stopReason).toBe("tool_use");

    const sessionKey = `${testAccount.slotKey}::${sessionId}`;
    const worker = coordinator.getActiveWorker(sessionKey);
    expect(worker?.state).toBe("AWAITING_TOOL_RESULTS");

    // Turn 2 delivers tool_result
    const toolCallId = (toolUse as any).id;
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Tool system prompt",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please TRIGGER_TOOL_CALL" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolCallId,
              name: "get_weather",
              input: { city: "San Francisco" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: toolCallId,
              isError: false,
              content: [{ type: "text", text: "Sunny and 75F" }],
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

    const events2: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req2, sel)) {
      events2.push(event);
    }

    const text2 = events2
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text2).toContain("The weather in San Francisco is Sunny and 75F.");

    const finish2 = events2.find((e) => e.type === "finish");
    expect(finish2?.type === "finish" && finish2.stopReason).toBe("end_turn");
    expect(worker?.state).toBe("IDLE");
  });

  test("3. Parallel tool calls + late sibling tool call arriving 80ms after first batch", async () => {
    const sessionId = `test-parallel-${Date.now()}`;
    const tools = [
      {
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object" },
      },
      {
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object" },
      },
    ];

    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Late sibling test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please TRIGGER_LATE_SIBLING" }],
        },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    // Turn 1
    const events1: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req1, sel)) {
      events1.push(event);
    }

    const toolUse1 = events1.filter((e) => e.type === "tool_use");
    expect(toolUse1.length).toBe(1);
    expect(toolUse1[0]!.type === "tool_use" && toolUse1[0]!.name).toBe("tool_a");
    const call1Id = (toolUse1[0] as any).id;

    // Wait slightly so late sibling arrives in broker
    await new Promise((r) => setTimeout(r, 120));

    // Turn 2: resolve tool_a
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Late sibling test",
      messages: [
        ...req1.messages,
        {
          role: "assistant",
          content: [toolUse1[0] as any],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: call1Id,
              isError: false,
              content: [{ type: "text", text: "Result A" }],
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

    const events2: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req2, sel)) {
      events2.push(event);
    }

    // Turn 2 yields late sibling tool_b!
    const toolUse2 = events2.filter((e) => e.type === "tool_use");
    expect(toolUse2.length).toBe(1);
    expect(toolUse2[0]!.type === "tool_use" && toolUse2[0]!.name).toBe("tool_b");
    const call2Id = (toolUse2[0] as any).id;

    // Turn 3: resolve tool_b
    const req3: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Late sibling test",
      messages: [
        ...req2.messages,
        {
          role: "assistant",
          content: [toolUse2[0] as any],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: call2Id,
              isError: false,
              content: [{ type: "text", text: "Result B" }],
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

    const events3: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req3, sel)) {
      events3.push(event);
    }

    const finish3 = events3.find((e) => e.type === "finish");
    expect(finish3?.type === "finish" && finish3.stopReason).toBe("end_turn");
  });

  test("4. AbortSignal during GENERATING cancels promptly", async () => {
    const sessionId = `test-abort-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Cancel test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please TRIGGER_CANCEL_TEST" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const controller = new AbortController();
    const generator = coordinator.executeTurn(
      testAccount,
      req,
      sel,
      undefined,
      controller.signal,
    );

    const first = await generator.next();
    expect(first.value).toBeDefined();

    // Abort during generation
    controller.abort();

    // Generator should conclude quickly
    const remaining = await generator.next();
    expect(remaining.done).toBe(true);

    const worker = coordinator.getActiveWorker(`${testAccount.slotKey}::${sessionId}`);
    expect(worker?.state).toBe("IDLE");
  });

  test("5. Branching while AWAITING_TOOL_RESULTS returns 409", async () => {
    const sessionId = `test-branch-409-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Weather",
        inputSchema: { type: "object" },
      },
    ];

    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Branch test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }],
        },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    // Turn 1 leaves worker in AWAITING_TOOL_RESULTS
    for await (const _ of coordinator.executeTurn(testAccount, req1, sel)) {}

    // Send branched request (completely different history)
    const reqBranch: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Branch test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Unrelated new branch question" }],
        },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    let caughtError: any = null;
    try {
      for await (const _ of coordinator.executeTurn(testAccount, reqBranch, sel)) {}
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BridgeHttpError);
    expect(caughtError?.status).toBe(409);
    expect(caughtError?.message).toContain("Cannot branch session while tool calls are pending");

    // Worker remains unharmed in AWAITING_TOOL_RESULTS
    const worker = coordinator.getActiveWorker(`${testAccount.slotKey}::${sessionId}`);
    expect(worker?.state).toBe("AWAITING_TOOL_RESULTS");
  });

  test("6. Steer-in-session (tool_result + trailing user text)", async () => {
    const sessionId = `test-steer-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Weather",
        inputSchema: { type: "object" },
      },
    ];

    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Steer test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }],
        },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    let toolCallId = "";
    for await (const event of coordinator.executeTurn(testAccount, req1, sel)) {
      if (event.type === "tool_use") toolCallId = event.id;
    }

    // Turn 2 with tool_result AND steering text
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Steer test",
      messages: [
        ...req1.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolCallId,
              name: "get_weather",
              input: { city: "San Francisco" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: toolCallId,
              isError: false,
              content: [{ type: "text", text: "75F" }],
            },
            {
              type: "text",
              text: "Steered follow-up: Tell me a joke",
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

    const events2: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req2, sel)) {
      events2.push(event);
    }

    const text2 = events2
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as any).text)
      .join("");
    expect(text2).toContain("Steered follow-up: Tell me a joke");
  });

  test("7. GlobalScheduler evicts IDLE workers LRU, but NEVER evicts AWAITING_TOOL_RESULTS", async () => {
    const smallScheduler = new GlobalScheduler({
      maxGlobalWorkers: 2,
      maxPerAccountWorkers: 2,
    });

    const mockWorkerIdle: any = {
      account: testAccount,
      state: "IDLE",
      lastActivityAt: 1000,
      close: async () => {},
    };

    const mockWorkerBusy: any = {
      account: testAccount,
      state: "AWAITING_TOOL_RESULTS",
      lastActivityAt: 2000,
      close: async () => {},
    };

    smallScheduler.registerWorker(mockWorkerIdle);
    smallScheduler.registerWorker(mockWorkerBusy);

    // Eviction when full evicts IDLE worker
    await smallScheduler.ensureCapacity(testAccount);
    expect(smallScheduler.getActiveWorkers()).not.toContain(mockWorkerIdle);

    // Now add another busy worker (both are AWAITING_TOOL_RESULTS)
    const mockWorkerBusy2: any = {
      account: testAccount,
      state: "AWAITING_TOOL_RESULTS",
      lastActivityAt: 3000,
      close: async () => {},
    };
    smallScheduler.registerWorker(mockWorkerBusy2);

    // Now capacity is 2 and BOTH are AWAITING_TOOL_RESULTS
    let error503: any = null;
    try {
      await smallScheduler.ensureCapacity(testAccount);
    } catch (err) {
      error503 = err;
    }

    expect(error503).toBeInstanceOf(BridgeHttpError);
    expect(error503?.status).toBe(503);
    expect(error503?.message).toContain("All Antigravity session workers are busy or awaiting tool results");

    smallScheduler.destroy();
  });

  test("8. Thinking accumulation and synthetic thinking signature", async () => {
    const sessionId = `test-think-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Think test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "TRIGGER_THINKING" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: true,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
      effort: "medium",
    };

    const events: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req, sel)) {
      events.push(event);
    }

    const thinkDelta = events.find((e) => e.type === "thinking_delta");
    expect(thinkDelta).toBeDefined();

    const thinkSig = events.find((e) => e.type === "thinking_signature");
    expect(thinkSig).toBeDefined();
    expect(thinkSig?.type === "thinking_signature" && thinkSig.signature.startsWith("agy1.")).toBe(true);
  });

  test("9. Stateless request (sessionId === null) runs on ephemeral worker", async () => {
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Stateless test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Stateless prompt" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId: null,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const events: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req, sel)) {
      events.push(event);
    }

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect(finish?.type === "finish" && finish.stopReason).toBe("end_turn");

    // Worker was ephemeral and closed
    expect(coordinator.getActiveWorker(`${testAccount.slotKey}::null`)).toBeUndefined();
  });

  test("10. Orphan tool_result is rejected up front with 400", async () => {
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Orphan test",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_nonexistent",
              isError: false,
              content: [{ type: "text", text: "Result" }],
            },
          ],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId: `test-orphan-${Date.now()}`,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    let caught: any = null;
    try {
      for await (const _ of coordinator.executeTurn(testAccount, req, sel)) {}
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BridgeHttpError);
    expect(caught?.status).toBe(400);
    expect(caught?.message).toContain("Orphan tool_result");
  });

  test("11. Error marker withholding and rate-limit diagnosis", async () => {
    const sessionId = `test-err-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Error test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "TRIGGER_ERROR_TERMINATION" }],
        },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const events: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req, sel)) {
      events.push(event);
    }

    // Literal marker "⚠ Agent execution terminated due to error." must be withheld
    for (const ev of events) {
      if (ev.type === "text_delta") {
        expect(ev.text).not.toContain("⚠ Agent execution terminated due to error.");
      }
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.type === "error" && errorEvent.status).toBeGreaterThanOrEqual(400);
  });

  test("12. Nested session/update envelope parsing and session ID filtering", async () => {
    const sessionId = `test-nested-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello nested" }] },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const events: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req, sel)) {
      events.push(event);
    }

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker).toBeDefined();

    // Mismatched sessionId in session/update must be ignored
    (worker as any).handleSessionUpdate({
      sessionId: "different-session-id",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "ignored chunk" },
      },
    });

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
  });

  test("13. Streaming turn commits committedMessages before yielding finish (SSE consumer early exit)", async () => {
    const sessionId = `test-commit-before-finish-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "Commits early" }] },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const generator = coordinator.executeTurn(testAccount, req, sel);
    for await (const event of generator) {
      if (event.type === "finish") {
        // Break immediately on finish (same as encodeAnthropicSseResponse calling iterator.return())
        break;
      }
    }

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    );
    expect(worker).toBeDefined();
    expect(worker!.committedMessages.length).toBe(2);
    expect(worker!.committedMessages[0]!.role).toBe("user");
    expect(worker!.committedMessages[1]!.role).toBe("assistant");
    expect((worker!.committedMessages[1]!.content[0] as any).text).toContain(
      "Commits early",
    );
  });

  test("14. Reusing a worker for a tool call after an aborted turn (openTurnWindow regression)", async () => {
    const sessionId = `test-abort-reuse-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];

    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "TRIGGER_CANCEL_TEST" }] },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    const controller = new AbortController();
    const gen1 = coordinator.executeTurn(
      testAccount,
      req1,
      sel,
      undefined,
      controller.signal,
    );
    await gen1.next();
    controller.abort();
    for await (const _ of gen1) {}

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    );
    expect(worker?.state).toBe("IDLE");

    // Turn 2 on same session triggers a tool call: openTurnWindow must ensure tool is exposed
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        ...worker!.committedMessages,
        { role: "user", content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }] },
      ],
      tools,
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    const events2: TurnStreamEvent[] = [];
    for await (const event of coordinator.executeTurn(testAccount, req2, sel)) {
      events2.push(event);
    }

    const toolUse = events2.find((e) => e.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.type === "tool_use" && toolUse.name).toBe("get_weather");
    expect(worker?.state).toBe("AWAITING_TOOL_RESULTS");

    await worker?.close("test14_done");
  });

  test("15. worker.close() unregisters from LoopbackMcpServer and sessionLocks map cleans up", async () => {
    const sessionId = `test-cleanup-${Date.now()}`;
    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "Cleanup test" }] },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    for await (const _ of coordinator.executeTurn(testAccount, req, sel)) {}

    const sessionKey = `${testAccount.slotKey}::${testAccount.accountRef}::${sessionId}`;
    // sessionLocks map must be cleaned up after turn finishes
    expect((coordinator as any).sessionLocks.has(sessionKey)).toBe(false);

    const worker = coordinator.getActiveWorker(sessionKey)!;
    expect(worker).toBeDefined();
    const token = (worker as any).mcpToken;
    expect(token).toBeDefined();
    expect((mcpServer as any).sessions.has(token)).toBe(true);

    // Close worker
    await worker.close("manual_test_close");

    // Must be unregistered from LoopbackMcpServer
    expect((mcpServer as any).sessions.has(token)).toBe(false);
  });

  test("16. Re-authenticated account mismatch retires old worker instead of reusing", async () => {
    const sessionId = `test-reauth-${Date.now()}`;
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "First account" }] },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    const sel: ModelSelection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    for await (const _ of coordinator.executeTurn(testAccount, req1, sel)) {}

    const worker1 = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker1).toBeDefined();
    expect(worker1.account.accountRef).toBe(testAccount.accountRef);

    // Second request with SAME slotKey and SAME sessionId, but DIFFERENT accountRef (re-authenticated)
    const reauthAccount: AccountDescriptor = {
      ...testAccount,
      accountRef: "22222222-2222-4222-8222-222222222222",
    };

    const req2: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        { role: "user", content: [{ type: "text", text: "Reauth account" }] },
      ],
    };

    for await (const _ of coordinator.executeTurn(reauthAccount, req2, sel)) {}

    // worker1 should have been closed with account_mismatch
    expect(worker1.state).toBe("CLOSED");

    // New active worker has the new accountRef
    const worker2 = coordinator.getActiveWorker(
      `${reauthAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker2).toBeDefined();
    expect(worker2.account.accountRef).toBe(reauthAccount.accountRef);
  });
});
