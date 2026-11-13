#!/usr/bin/env bun
import readline from "node:readline";

let mcpUrl: string | null = null;
let currentSessionId: string | null = null;
let currentModel = "default";
let currentThoughtLevel = "default";
let appendedSystemPrompt = "";
let cancelled = false;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(data: any): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function notify(method: string, params: any): void {
  if (method === "session/update") {
    if (params && params.update !== undefined) {
      send({ jsonrpc: "2.0", method, params });
    } else {
      send({
        jsonrpc: "2.0",
        method,
        params: {
          sessionId: currentSessionId,
          update: params,
        },
      });
    }
  } else {
    send({ jsonrpc: "2.0", method, params });
  }
}

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  callId: string,
): Promise<any> {
  if (!mcpUrl) throw new Error("No mcpUrl set");

  // First discover tool's actual MCP name from tools/list
  let targetName = toolName;
  try {
    const listRes: any = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "list-tools",
        method: "tools/list",
        params: {},
      }),
    }).then((r) => r.json());

    const tools = listRes?.result?.tools;
    if (Array.isArray(tools)) {
      const match = tools.find(
        (t: any) =>
          t.name === toolName ||
          t.name === `mcp_magpie_${toolName}` ||
          t.name.endsWith(`_${toolName}`),
      );
      if (match) {
        targetName = match.name;
      }
    }
  } catch {}

  notify("session/update", {
    sessionUpdate: "tool_call",
    toolCallId: callId,
    name: toolName,
  });

  const res: any = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: targetName,
        arguments: args,
      },
    }),
  }).then((r) => r.json());

  notify("session/update", {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status: res?.result?.isError ? "failed" : "completed",
  });

  return res?.result;
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
          },
          promptCapabilities: {
            image: true,
          },
          _meta: {
            antigravity: {
              systemPrompt: {
                append: true,
              },
            },
          },
        },
      },
    });
    return;
  }

  if (method === "session/new") {
    mcpUrl = params?.mcpServers?.[0]?.url ?? null;
    appendedSystemPrompt = params?._meta?.antigravity?.systemPrompt?.append ?? "";
    const sessionId = `fake-session-${Math.random().toString(36).slice(2, 10)}`;
    currentSessionId = sessionId;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId,
        configOptions: [
          {
            id: "model",
            options: [
              { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
              { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
            ],
          },
          {
            id: "thought_level",
            options: ["minimal", "low", "medium", "high", "max"],
          },
        ],
      },
    });
    return;
  }

  if (method === "session/resume") {
    mcpUrl = params?.mcpServers?.[0]?.url ?? null;
    appendedSystemPrompt = params?._meta?.antigravity?.systemPrompt?.append ?? "";
    currentSessionId = params?.sessionId ?? "resumed-session";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: currentSessionId,
        configOptions: [
          {
            id: "model",
            options: [
              { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
              { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
            ],
          },
          {
            id: "thought_level",
            options: ["minimal", "low", "medium", "high", "max"],
          },
        ],
      },
    });
    return;
  }

  if (method === "session/set_config_option") {
    if (params?.configId === "model") {
      currentModel = params.value;
    } else if (params?.configId === "thought_level") {
      currentThoughtLevel = params.value;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { status: "ok" },
    });
    return;
  }

  if (method === "session/set_model") {
    currentModel = params?.modelId ?? currentModel;
    send({
      jsonrpc: "2.0",
      id,
      result: { status: "ok" },
    });
    return;
  }

  if (method === "session/cancel") {
    cancelled = true;
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: { status: "cancelled" },
      });
    }
    return;
  }

  if (method === "session/prompt") {
    cancelled = false;
    let promptText = "";
    if (typeof params?.prompt === "string") {
      promptText = params.prompt;
    } else if (Array.isArray(params?.prompt)) {
      promptText = params.prompt
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
    }

    // Check for PERMISSION_REQUEST
    if (promptText.includes("TRIGGER_PERMISSION_REQUEST")) {
      const permId = `perm-${Math.random().toString(36).slice(2)}`;
      const permPromise = new Promise((resolve) => {
        const handler = (l: string) => {
          try {
            const m = JSON.parse(l.trim());
            if (m.id === permId) {
              rl.off("line", handler);
              resolve(m.result);
            }
          } catch {}
        };
        rl.on("line", handler);
      });

      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
      });

      const permRes: any = await permPromise;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          permissionOutcome: permRes?.outcome,
          usage: { inputTokens: 5, outputTokens: 5 },
        },
      });
      return;
    }

    // Check for ERROR_TERMINATION
    if (promptText.includes("TRIGGER_ERROR_TERMINATION")) {
      notify("session/update", {
        sessionUpdate: "agent_message_chunk",
        content: { text: "⚠ Agent execution terminated due to error." },
      });
      send({
        jsonrpc: "2.0",
        id,
        result: {
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
      return;
    }

    // Check for THINKING
    if (promptText.includes("TRIGGER_THINKING")) {
      notify("session/update", {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "Thinking deeply about the task..." },
      });
    }

    // Check for TOOL_CALL
    if (promptText.includes("TRIGGER_TOOL_CALL")) {
      try {
        const toolResult = await callMcpTool(
          "get_weather",
          { city: "San Francisco" },
          "call_weather_1",
        );

        if (cancelled) return;

        const resText = toolResult?.content?.[0]?.text ?? "72F";
        notify("session/update", {
          sessionUpdate: "agent_message_chunk",
          content: {
            text: `The weather in San Francisco is ${resText}.`,
          },
        });

        send({
          jsonrpc: "2.0",
          id,
          result: {
            usage: {
              inputTokens: 50,
              outputTokens: 25,
              cachedReadTokens: 10,
              cachedWriteTokens: 5,
            },
          },
        });
      } catch (err: any) {
        if (!cancelled) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err?.message || String(err) },
          });
        }
      }
      return;
    }

    // Check for LATE_SIBLING
    if (promptText.includes("TRIGGER_LATE_SIBLING")) {
      try {
        // Start call 1
        const p1 = callMcpTool("tool_a", { step: 1 }, "call_late_1");

        // Wait 80ms before issuing call 2
        await new Promise((r) => setTimeout(r, 80));
        const p2 = callMcpTool("tool_b", { step: 2 }, "call_late_2");

        const [r1, r2] = await Promise.all([p1, p2]);
        if (cancelled) return;

        const t1 = r1?.content?.[0]?.text ?? "Done 1";
        const t2 = r2?.content?.[0]?.text ?? "Done 2";

        notify("session/update", {
          sessionUpdate: "agent_message_chunk",
          content: { text: `Late sibling results: ${t1} and ${t2}` },
        });

        send({
          jsonrpc: "2.0",
          id,
          result: {
            usage: { inputTokens: 70, outputTokens: 35 },
          },
        });
      } catch (err: any) {
        if (!cancelled) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err?.message || String(err) },
          });
        }
      }
      return;
    }

    // Check for CANCEL_TEST
    if (promptText.includes("TRIGGER_CANCEL_TEST")) {
      notify("session/update", {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Starting cancel test..." },
      });

      // Wait up to 5 seconds unless cancelled
      for (let i = 0; i < 50; i++) {
        if (cancelled) {
          send({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "cancelled" },
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!cancelled) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            usage: { inputTokens: 10, outputTokens: 10 },
          },
        });
      }
      return;
    }

    // Default response: stream message chunks then complete
    const sysProbe = promptText.includes("INSPECT_SYSTEM_APPEND")
      ? ` [sysAppendBytes=${Buffer.byteLength(appendedSystemPrompt, "utf-8")}, hasPriorTag=${appendedSystemPrompt.includes("<prior_conversation_history>")}, hasFirst=${appendedSystemPrompt.includes("SEED_HEAD_MARKER_0")}]`
      : "";
    const resumeProbe = promptText.includes("INSPECT_RESUME")
      ? ` [resumedSessionId=${currentSessionId}]`
      : "";
    notify("session/update", {
      sessionUpdate: "agent_message_chunk",
      content: {
        text: `Answer: ${promptText} [model=${currentModel}, effort=${currentThoughtLevel}]${sysProbe}${resumeProbe}`,
      },
    });

    send({
      jsonrpc: "2.0",
      id,
      result: {
        usage: {
          inputTokens: 25,
          outputTokens: 15,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
        },
      },
    });
  }
});
