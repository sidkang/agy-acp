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
import { settleStepUsage } from "../src/usage/step-usage";

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

  test("17. Rotating x-anthropic-billing-header: cch=... across turns reuses the warm worker (0 session resets!)", async () => {
    const sessionId = `test-billing-${Date.now()}`;
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system:
        "x-anthropic-billing-header: cch=1111aaaa;\nYou are a helpful coding assistant.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello turn 1" }] },
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
    expect(worker1.state).toBe("IDLE");

    // Turn 2 has a DIFFERENT cch hash on the billing header
    const req2: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system:
        "x-anthropic-billing-header: cch=2222bbbb;\nYou are a helpful coding assistant.",
      messages: [
        ...worker1.committedMessages,
        { role: "user", content: [{ type: "text", text: "Hello turn 2" }] },
      ],
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };

    for await (const _ of coordinator.executeTurn(testAccount, req2, sel)) {}

    const worker2 = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker2).toBe(worker1); // Reused identical warm worker, 0 resets!
    expect(worker1.state).toBe("IDLE");
    await worker2.close("test_done");
  });

  test("18. <system-reminder>PreToolUse hook...</system-reminder> alongside tool_result attaches to MCP tool result and does NOT send session/cancel, whereas <system-reminder>The user sent a new message while you were working: stop and say HI</system-reminder> triggers steering", async () => {
    const sessionId = `test-reminder-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Weather",
        inputSchema: { type: "object" },
      },
    ];
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Test reminders",
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

    const events1: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req1, sel)) {
      events1.push(ev);
    }
    const toolUse1 = events1.find((e) => e.type === "tool_use") as any;
    expect(toolUse1).toBeDefined();
    const toolCallId1 = toolUse1.id;

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker.state).toBe("AWAITING_TOOL_RESULTS");

    // Case A: Companion notice alongside tool_result
    const req2: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        ...worker.committedMessages,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: toolCallId1,
              isError: false,
              content: [{ type: "text", text: "75F sunny" }],
            },
            {
              type: "text",
              text: "<system-reminder>PreToolUse hook executed successfully</system-reminder>",
            },
          ],
        },
      ],
    };
    const events2: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req2, sel)) {
      events2.push(ev);
    }
    expect(worker.state).toBe("IDLE");
    expect(events2.some((e) => e.type === "finish")).toBe(true);

    // Case B: Trigger another tool call, then test queued user steering
    const req3: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        ...worker.committedMessages,
        {
          role: "user",
          content: [{ type: "text", text: "TRIGGER_TOOL_CALL" }],
        },
      ],
    };
    const events3: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req3, sel)) {
      events3.push(ev);
    }
    const toolUse3 = events3.find((e) => e.type === "tool_use") as any;
    expect(toolUse3).toBeDefined();
    const toolCallId3 = toolUse3.id;
    expect(worker.state).toBe("AWAITING_TOOL_RESULTS");

    const req4: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        ...worker.committedMessages,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: toolCallId3,
              isError: false,
              content: [{ type: "text", text: "75F" }],
            },
            {
              type: "text",
              text: "<system-reminder>The user sent a new message while you were working: stop and say HI</system-reminder>",
            },
          ],
        },
      ],
    };
    const events4: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req4, sel)) {
      events4.push(ev);
    }
    expect(worker.state).toBe("IDLE");
    expect(events4.some((e) => e.type === "finish")).toBe(true);
    await worker.close("test_done");
  });

  test("19. Reordered JSON keys / added default field on tool_use.input in client history still matches AWAITING_TOOL_RESULTS without throwing 409", async () => {
    const sessionId = `test-reordered-keys-${Date.now()}`;
    const tools = [
      {
        name: "get_weather",
        description: "Weather",
        inputSchema: { type: "object" },
      },
    ];
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Key ordering test",
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

    const events1: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req1, sel)) {
      events1.push(ev);
    }
    const toolUse1 = events1.find((e) => e.type === "tool_use") as any;
    expect(toolUse1).toBeDefined();
    const toolCallId = toolUse1.id;

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker.state).toBe("AWAITING_TOOL_RESULTS");

    // Client sends history where tool_use has added default param / different input keys
    const modifiedCommitted = worker.committedMessages.map((msg) => {
      if (msg.role === "assistant") {
        return {
          role: "assistant" as const,
          content: msg.content.map((part) => {
            if (part.type === "tool_use") {
              return {
                ...part,
                input: { ...part.input, defaultSchemaParam: true, reordered: "val" },
              };
            }
            return part;
          }),
        };
      }
      return msg;
    });

    const req2: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        ...modifiedCommitted,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: toolCallId,
              isError: false,
              content: [{ type: "text", text: "72F" }],
            },
          ],
        },
      ],
    };

    const events: TurnStreamEvent[] = [];
    for await (const ev of coordinator.executeTurn(testAccount, req2, sel)) {
      events.push(ev);
    }
    expect(worker.state).toBe("IDLE");
    expect(events.some((e) => e.type === "finish")).toBe(true);
    await worker.close("test_done");
  });

  test("20. Assistant prefill merges onto a single assistant message in committedMessages and reuses warm session on Turn N+1", async () => {
    const sessionId = `test-prefill-${Date.now()}`;
    const req1: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Prefill test",
      messages: [
        { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
        { role: "assistant", content: [{ type: "text", text: "Answer: " }] },
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
    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker).toBeDefined();

    // committedMessages must have merged prefill and completion into exactly ONE assistant message
    expect(worker.committedMessages.length).toBe(2);
    expect(worker.committedMessages[0]!.role).toBe("user");
    expect(worker.committedMessages[1]!.role).toBe("assistant");
    const fullAssistantText = (worker.committedMessages[1]!.content[0] as any)
      .text;
    expect(fullAssistantText).toContain("Answer: ");

    // Turn N+1: Client sends follow-up user turn
    const req2: NormalizedAnthropicRequest = {
      ...req1,
      messages: [
        ...worker.committedMessages,
        { role: "user", content: [{ type: "text", text: "And 3+3?" }] },
      ],
    };

    for await (const _ of coordinator.executeTurn(testAccount, req2, sel)) {}
    const worker2 = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker2).toBe(worker); // Warm reuse!
    expect(worker.state).toBe("IDLE");
    await worker2.close("test_done");
  });

  test("21. 112 KiB replay budget preserves <current_turn> intact when <conversation_history> is 200 KiB", async () => {
    const sessionId = `test-budget-${Date.now()}`;
    const hugeChunk = "X".repeat(15 * 1024); // 15 KiB (> 12 KiB clip limit)
    const priorMessages: any[] = [];
    for (let i = 0; i < 15; i++) {
      priorMessages.push(
        {
          role: "user",
          content: [{ type: "text", text: `Old question ${i}: ${hugeChunk}` }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `Old answer ${i}: ${hugeChunk}` }],
        },
      );
    }

    const req: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Budget test",
      messages: [
        ...priorMessages,
        {
          role: "user",
          content: [{ type: "text", text: "TARGET_CURRENT_TURN_PROMPT" }],
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

    let finishEvent: any = null;
    for await (const ev of coordinator.executeTurn(testAccount, req, sel)) {
      if (ev.type === "finish") finishEvent = ev;
    }
    expect(finishEvent).toBeDefined();

    const worker = coordinator.getActiveWorker(
      `${testAccount.slotKey}::${sessionId}`,
    )!;
    expect(worker).toBeDefined();
    expect(worker.state).toBe("IDLE");
    await worker.close("test_done");
  });

  test("22. Concurrent Promise.all worker acquisitions strictly obey maxPerAccountWorkers / maxGlobalWorkers", async () => {
    const smallScheduler = new GlobalScheduler({
      maxGlobalWorkers: 2,
      maxPerAccountWorkers: 2,
    });

    const w1 = new AgySessionWorker(testAccount, "sess-1", mcpServer, {
      spawnFn: spawnFakeAcp,
    });
    const w2 = new AgySessionWorker(testAccount, "sess-2", mcpServer, {
      spawnFn: spawnFakeAcp,
    });
    const w3 = new AgySessionWorker(testAccount, "sess-3", mcpServer, {
      spawnFn: spawnFakeAcp,
    });
    const w4 = new AgySessionWorker(testAccount, "sess-4", mcpServer, {
      spawnFn: spawnFakeAcp,
    });

    // All 4 workers in STARTING state
    const results = await Promise.allSettled([
      smallScheduler.reserveAndRegister(w1),
      smallScheduler.reserveAndRegister(w2),
      smallScheduler.reserveAndRegister(w3),
      smallScheduler.reserveAndRegister(w4),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(2);
    expect(smallScheduler.getActiveCount()).toBe(2);

    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        BridgeHttpError,
      );
      expect(
        ((r as PromiseRejectedResult).reason as BridgeHttpError).status,
      ).toBe(503);
    }

    await smallScheduler.closeAll();
    smallScheduler.destroy();
  });

  test("23. Title/summary tool-less side request on the same sessionId does NOT evict the main warm tool-bearing worker", async () => {
    const sideAccount: AccountDescriptor = {
      slotKey: "agy#side-req",
      accountRef: "33333333-3333-4333-8333-333333333333",
      mode: "host",
      label: "Side Test Account",
      isolatedHomeDir: null,
    };
    const sessionId = `test-side-req-${Date.now()}`;
    const tools = [
      { name: "bash", description: "Bash", inputSchema: { type: "object" } },
    ];
    const reqMain: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Main tool session",
      messages: [{ role: "user", content: [{ type: "text", text: "Start" }] }],
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

    for await (const _ of coordinator.executeTurn(sideAccount, reqMain, sel)) {}
    const mainWorker = coordinator.getActiveWorker(
      `${sideAccount.slotKey}::${sessionId}`,
    )!;
    expect(mainWorker).toBeDefined();
    expect(mainWorker.state).toBe("IDLE");
    expect(mainWorker.registeredTools.length).toBe(1);

    // Send title side-request with tools: [] and completely different question
    const reqTitle: NormalizedAnthropicRequest = {
      model: "gemini-3.8-flash",
      system: "Title generator",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Generate a short title" }],
        },
      ],
      tools: [],
      toolChoice: { type: "none" },
      stream: true,
      thinkingEnabled: false,
      sessionId,
    };
    for await (const _ of coordinator.executeTurn(sideAccount, reqTitle, sel)) {}

    // The main worker is STILL active and IDLE! Not evicted or closed!
    const checkWorker = coordinator.getActiveWorker(
      `${sideAccount.slotKey}::${sessionId}`,
    )!;
    expect(checkWorker).toBe(mainWorker);
    expect(mainWorker.state).toBe("IDLE");
    expect(mainWorker.registeredTools.length).toBe(1);
    await mainWorker.close("test_done");
  });

  test("24. settleStepUsage unit tests and normalization", () => {
    // 1. Single-step normalization with double-counted folded tokens
    const u1 = settleStepUsage(
      {
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 20,
        cachedWriteTokens: 10,
        totalTokens: 150,
      },
      1,
    );
    expect(u1.outputTokens).toBe(50);
    expect(u1.cacheCreationInputTokens).toBe(10);
    expect(u1.inputTokens).toBe(80);
    expect(u1.cacheReadInputTokens).toBe(20);

    // 2. Multi-step estimation without SQLite measurements
    const u2 = settleStepUsage(
      {
        inputTokens: 300,
        outputTokens: 60,
        cachedReadTokens: 60,
        totalTokens: 420,
      },
      3,
    );
    expect(u2.inputTokens).toBe(100);
    expect(u2.cacheReadInputTokens).toBe(20);
    expect(u2.outputTokens).toBe(60);

    // 3. Exact measurement from SQLite stepMeasurements wins
    const u3 = settleStepUsage(
      { inputTokens: 99999, outputTokens: 99999 },
      5,
      [
        { idx: 1, input: 40, output: 20, write: 5, read: 10, thinking: 0 },
        { idx: 2, input: 50, output: 25, write: 5, read: 15, thinking: 0 },
      ],
    );
    expect(u3.inputTokens).toBe(50);
    expect(u3.outputTokens).toBe(25);
    expect(u3.cacheReadInputTokens).toBe(15);
    expect(u3.cacheCreationInputTokens).toBe(5);
  });
});
