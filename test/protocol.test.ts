import { describe, expect, test } from "bun:test";

import {
  ALT_SESSION_ID_HEADER,
  ALT_SUBAGENT_HEADER,
  collectAnthropicJsonResponse,
  OPENING_THINKING_SIGNATURE,
  thinkingSignatureFor,
  EFFORT_HEADER,
  encodeAnthropicSseResponse,
  jsonErrorResponse,
  parseAnthropicRequest,
  SESSION_ID_HEADER,
  SIGN_IN_HEADER,
  SUBAGENT_HEADER,
  WORKDIR_HEADER,
} from "../src/protocol/anthropic";
import {
  cloakSystemPrompt,
  refusalHint,
  stripVolatileMessageText,
  stripVolatileSystem,
  turnsAway,
} from "../src/protocol/cloak";
import {
  BridgeHttpError,
  type ProviderOptionsState,
  type TokenUsageSummary,
  type TurnStreamEvent,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const MODEL = "gemini-3.8-flash";

const DEFAULT_OPTIONS: ProviderOptionsState = {
  quotaRouting: true,
  minimalAgent: false,
  exposeThinking: true,
  cloakPrompts: true,
};

const USAGE: TokenUsageSummary = {
  inputTokens: 11,
  outputTokens: 22,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
};

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function parse(
  body: unknown,
  options: Partial<ProviderOptionsState> = {},
  headerEntries: Record<string, string> = {},
) {
  return parseAnthropicRequest(JSON.stringify(body), new Headers(headerEntries), {
    ...DEFAULT_OPTIONS,
    ...options,
  });
}

function expectInvalid(fn: () => unknown, messageIncludes?: string): BridgeHttpError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof BridgeHttpError)) {
    throw new Error(`expected BridgeHttpError, received ${String(caught)}`);
  }
  expect(caught.status).toBe(400);
  expect(caught.errorType).toBe("invalid_request_error");
  if (messageIncludes !== undefined) expect(caught.message).toContain(messageIncludes);
  return caught;
}

async function* streamOf(events: TurnStreamEvent[]): AsyncGenerator<TurnStreamEvent> {
  for (const event of events) yield event;
}

/** Yields `events`, then throws `error` from the iterator (a mid-stream failure). */
async function* streamThatFailsAfter(
  events: TurnStreamEvent[],
  error: unknown,
): AsyncGenerator<TurnStreamEvent> {
  for (const event of events) yield event;
  throw error;
}

/** A hand-rolled async iterable that records teardown, like the runtime's generators. */
function trackedStream(events: TurnStreamEvent[]): {
  iterable: AsyncIterable<TurnStreamEvent>;
  state: { returned: boolean; pulled: number; completed: boolean };
} {
  const state = { returned: false, pulled: 0, completed: false };
  const iterable: AsyncIterable<TurnStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<TurnStreamEvent>> {
          state.pulled += 1;
          const value = events[index];
          if (value === undefined) {
            state.completed = true;
            return { done: true, value: undefined };
          }
          index += 1;
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<TurnStreamEvent>> {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, state };
}

/**
 * A drop-in `AbortSignal` that counts live "abort" listeners, so tests can
 * prove every response path detaches its listener.
 */
function trackingSignal(): {
  signal: AbortSignal;
  listenerCount: () => number;
  abort: () => void;
} {
  const listeners = new Map<EventListener, EventListener>();
  const signal = {
    aborted: false,
    addEventListener(
      type: string,
      listener: EventListener,
      options?: { once?: boolean },
    ): void {
      if (type !== "abort" || listeners.has(listener)) return;
      const wrapped: EventListener = (event) => {
        if (options?.once === true) listeners.delete(listener);
        listener(event);
      };
      listeners.set(listener, wrapped);
    },
    removeEventListener(type: string, listener: EventListener): void {
      if (type !== "abort") return;
      listeners.delete(listener);
    },
  };

  return {
    signal: signal as unknown as AbortSignal,
    listenerCount: () => listeners.size,
    abort: () => {
      if (signal.aborted) return;
      signal.aborted = true;
      for (const wrapped of [...listeners.values()]) {
        wrapped(new Event("abort"));
      }
    },
  };
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseSseFrames(payload: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const rawChunk of payload.split("\n\n")) {
    const chunk = rawChunk.trim();
    if (chunk === "") continue;
    let event = "";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    if (event === "" || data === "") throw new Error(`malformed SSE frame: ${JSON.stringify(chunk)}`);
    frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return frames;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireFrame(
  frames: SseFrame[],
  event: string,
  predicate?: (data: Record<string, unknown>) => boolean,
): SseFrame {
  for (const frame of frames) {
    if (frame.event === event && (predicate === undefined || predicate(frame.data))) return frame;
  }
  throw new Error(`missing "${event}" frame in ${frames.map((f) => f.event).join(", ")}`);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord(await response.json());
}

interface IntervalStats {
  created: number;
  cleared: number;
  outstanding: number;
}

/** Records heartbeat timers so we can prove none leak. */
async function withIntervalTracking(fn: () => Promise<void>): Promise<IntervalStats> {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set<unknown>();
  let created = 0;
  let cleared = 0;

  globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
    created += 1;
    const timer = realSetInterval(...args);
    live.add(timer);
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((...args: Parameters<typeof realClearInterval>) => {
    if (live.delete(args[0])) cleared += 1;
    return realClearInterval(...args);
  }) as unknown as typeof clearInterval;

  try {
    await fn();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
  return { created, cleared, outstanding: live.size };
}

// ---------------------------------------------------------------------------
// parseAnthropicRequest
// ---------------------------------------------------------------------------

describe("parseAnthropicRequest: model & streaming honesty", () => {
  test("omitted stream means JSON, false means JSON, only true means SSE", () => {
    expect(parse(requestBody()).stream).toBe(false);
    expect(parse(requestBody({ stream: false })).stream).toBe(false);
    expect(parse(requestBody({ stream: true })).stream).toBe(true);
  });

  test("non-boolean stream is rejected instead of guessed", () => {
    expectInvalid(() => parse(requestBody({ stream: "true" })), "stream must be a boolean");
    expectInvalid(() => parse(requestBody({ stream: 1 })), "stream must be a boolean");
    expectInvalid(() => parse(requestBody({ stream: null })), "stream must be a boolean");
  });

  test("invalid JSON bodies and non-object bodies are 400s", () => {
    const headers = new Headers();
    expectInvalid(() => parseAnthropicRequest("{not json", headers, DEFAULT_OPTIONS), "Invalid JSON");
    expectInvalid(() => parseAnthropicRequest(undefined, headers, DEFAULT_OPTIONS), "Invalid JSON");
    expectInvalid(() => parseAnthropicRequest(null, headers, DEFAULT_OPTIONS), "Invalid JSON");
    expectInvalid(() => parseAnthropicRequest('"just a string"', headers, DEFAULT_OPTIONS));
    expectInvalid(() => parseAnthropicRequest("[]", headers, DEFAULT_OPTIONS));
  });

  test("accepts a Uint8Array body", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(requestBody({ stream: true })));
    const parsed = parseAnthropicRequest(bytes, new Headers(), DEFAULT_OPTIONS);
    expect(parsed.stream).toBe(true);
    expect(parsed.messages).toHaveLength(1);
  });

  test("model is required and the agy-acp/ or agy/ prefix is stripped", () => {
    expectInvalid(() => parse(requestBody({ model: undefined })), "model is required");
    expectInvalid(() => parse(requestBody({ model: "   " })), "model is required");
    expectInvalid(() => parse(requestBody({ model: 42 })), "model is required");
    expect(parse(requestBody({ model: "agy-acp/gemini-3.8-flash" })).model).toBe(MODEL);
    expect(parse(requestBody({ model: "agy/gemini-3.8-flash" })).model).toBe(MODEL);
  });

  test("model :effort suffix becomes an effort override", () => {
    const parsed = parse(requestBody({ model: "agy/gemini-3.8-flash:xhigh" }));
    expect(parsed.model).toBe(MODEL);
    expect(parsed.effortOverride).toBe("xhigh");
  });

  test("[1m] context suffix is stripped from the model id", () => {
    // Trailing marker (Claude Code's 1M-context opt-in) and the variant that sits
    // just before a `:effort` suffix must both survive normalization.
    expect(parse(requestBody({ model: "agy-acp/claude-opus-5-5-low[1m]" })).model).toBe(
      "claude-opus-5-5-low",
    );
    const withEffort = parse(requestBody({ model: "agy-acp/gemini-3.8-flash[1m]:high" }));
    expect(withEffort.model).toBe(MODEL);
    expect(withEffort.effortOverride).toBe("high");
    expect(parse(requestBody({ model: "claude-opus-5-5-low[1M]" })).model).toBe(
      "claude-opus-5-5-low",
    );
    const trailingEffort = parse(requestBody({ model: "gemini-3.8-flash:low[1m]" }));
    expect(trailingEffort.model).toBe(MODEL);
    expect(trailingEffort.effortOverride).toBe("low");
  });

  test("output_config.effort and reasoning_effort are honored; model suffix wins", () => {
    expect(parse(requestBody({ output_config: { effort: "medium" } })).effortOverride).toBe(
      "medium",
    );
    expect(parse(requestBody({ reasoning_effort: "MAX" })).effortOverride).toBe("max");
    expect(
      parse(requestBody({ model: "gemini-3.8-flash:low", output_config: { effort: "high" } }))
        .effortOverride,
    ).toBe("low");
  });

  test("unsupported effort values are rejected, not silently dropped", () => {
    expectInvalid(
      () => parse(requestBody({ output_config: { effort: "turbo" } })),
      "Unsupported effort level",
    );
  });

  test("thinking budget maps to effort only when nothing explicit was requested", () => {
    expect(
      parse(requestBody({ thinking: { type: "enabled", budget_tokens: 1024 } })).effortOverride,
    ).toBe("low");
    expect(
      parse(requestBody({ thinking: { type: "enabled", budget_tokens: 4096 } })).effortOverride,
    ).toBe("medium");
    expect(
      parse(requestBody({ thinking: { budget_tokens: 32_000 } })).effortOverride,
    ).toBe("high");
    expect(
      parse(
        requestBody({
          thinking: { budget_tokens: 32_000 },
          output_config: { effort: "minimal" },
        }),
      ).effortOverride,
    ).toBe("minimal");
  });

  test("x-magpie-effort header supplies an effort override", () => {
    expect(EFFORT_HEADER).toBe("x-magpie-effort");
    expect(parse(requestBody(), {}, { [EFFORT_HEADER]: "high" }).effortOverride).toBe("high");
    expect(
      parse(requestBody(), {}, { [EFFORT_HEADER]: "  XHIGH  " }).effortOverride,
    ).toBe("xhigh");
    expect(parse(requestBody(), {}, { [EFFORT_HEADER]: "   " }).effortOverride).toBeUndefined();
  });

  test("effort precedence: model suffix > output_config > reasoning_effort > header > budget", () => {
    const header = { [EFFORT_HEADER]: "minimal" };

    // The thinking budget heuristic is the weakest source of all.
    expect(
      parse(requestBody({ thinking: { budget_tokens: 32_000 } }), {}, header).effortOverride,
    ).toBe("minimal");
    // reasoning_effort beats the header.
    expect(parse(requestBody({ reasoning_effort: "low" }), {}, header).effortOverride).toBe(
      "low",
    );
    // output_config.effort beats reasoning_effort and the header.
    expect(
      parse(
        requestBody({ reasoning_effort: "low", output_config: { effort: "medium" } }),
        {},
        header,
      ).effortOverride,
    ).toBe("medium");
    // The inline model suffix beats everything.
    expect(
      parse(
        requestBody({
          model: `${MODEL}:max`,
          reasoning_effort: "low",
          output_config: { effort: "medium" },
        }),
        {},
        header,
      ).effortOverride,
    ).toBe("max");
  });

  test("an unsupported x-magpie-effort value is rejected with a 400", () => {
    expectInvalid(
      () => parse(requestBody(), {}, { [EFFORT_HEADER]: "turbo" }),
      "x-magpie-effort",
    );
  });
});

describe("parseAnthropicRequest: thinking control", () => {
  test("disabled thinking always wins, otherwise exposeThinking decides", () => {
    expect(parse(requestBody({ thinking: { type: "disabled" } })).thinkingEnabled).toBe(false);
    expect(
      parse(requestBody({ thinking: { type: "disabled" } }), { exposeThinking: true })
        .thinkingEnabled,
    ).toBe(false);
    expect(parse(requestBody({ thinking: { type: "enabled" } })).thinkingEnabled).toBe(true);
    expect(parse(requestBody({ thinking: { type: "adaptive" } })).thinkingEnabled).toBe(true);
    expect(parse(requestBody()).thinkingEnabled).toBe(true);
    expect(
      parse(requestBody({ thinking: { type: "enabled" } }), { exposeThinking: false })
        .thinkingEnabled,
    ).toBe(false);
    expect(parse(requestBody(), { exposeThinking: false }).thinkingEnabled).toBe(false);
  });
});

describe("parseAnthropicRequest: unsupported parameters are rejected", () => {
  test("stop_sequences are rejected (never silently ignored)", () => {
    const err = expectInvalid(
      () => parse(requestBody({ stop_sequences: ["\n\nHuman:"] })),
      "stop_sequences are not supported",
    );
    expect(err.message).toBe(
      "stop_sequences are not supported by the Antigravity ACP runtime",
    );
    // An empty list asks for nothing, so it is fine.
    expect(parse(requestBody({ stop_sequences: [] })).stream).toBe(false);
    expectInvalid(() => parse(requestBody({ stop_sequences: "stop" })), "stop_sequences");
  });

  test("tool_choice auto/none is accepted", () => {
    expect(parse(requestBody()).toolChoice).toEqual({ type: "auto" });
    expect(parse(requestBody({ tool_choice: { type: "auto" } })).toolChoice).toEqual({
      type: "auto",
    });
    expect(parse(requestBody({ tool_choice: "auto" })).toolChoice).toEqual({ type: "auto" });
    expect(parse(requestBody({ tool_choice: "none" })).toolChoice).toEqual({ type: "none" });
    expect(
      parse(requestBody({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }))
        .toolChoice,
    ).toEqual({ type: "auto", disableParallelToolUse: true });
    expectInvalid(() => parse(requestBody({ tool_choice: { type: "bogus" } })), "tool_choice");
  });
});

describe("parseAnthropicRequest: forced tool_choice", () => {
  const TOOLS = [
    { name: "search", input_schema: { type: "object" } },
    { name: "browse", input_schema: { type: "object" } },
  ];

  test("any/required force a tool and need a declared catalog", () => {
    for (const type of ["any", "required", { type: "any" }]) {
      expect(parse(requestBody({ tools: TOOLS, tool_choice: type })).toolChoice).toEqual({
        type: "any",
      });
    }
    expect(
      parse(
        requestBody({
          tools: TOOLS,
          tool_choice: { type: "any", disable_parallel_tool_use: true },
        }),
      ).toolChoice,
    ).toEqual({ type: "any", disableParallelToolUse: true });

    // "call some tool" with nothing to call is a caller bug, not a no-op.
    expectInvalid(
      () => parse(requestBody({ tool_choice: "any" })),
      'tool_choice "any" requires at least one declared tool',
    );
    expectInvalid(
      () => parse(requestBody({ tools: [], tool_choice: { type: "required" } })),
      "requires at least one declared tool",
    );
  });

  test("tool_choice tool names a declared tool (Anthropic and OpenAI shapes)", () => {
    expect(
      parse(requestBody({ tools: TOOLS, tool_choice: { type: "tool", name: "search" } }))
        .toolChoice,
    ).toEqual({ type: "tool", name: "search" });
    expect(
      parse(
        requestBody({
          tools: TOOLS,
          tool_choice: { type: "tool", name: " search ", disable_parallel_tool_use: true },
        }),
      ).toolChoice,
    ).toEqual({ type: "tool", name: "search", disableParallelToolUse: true });
    // OpenAI Responses translators emit { type: "function", function: { name } }.
    expect(
      parse(
        requestBody({ tools: TOOLS, tool_choice: { type: "function", function: { name: "browse" } } }),
      ).toolChoice,
    ).toEqual({ type: "tool", name: "browse" });

    expectInvalid(
      () => parse(requestBody({ tools: TOOLS, tool_choice: { type: "tool" } })),
      'requires a non-empty tool "name"',
    );
    expectInvalid(
      () => parse(requestBody({ tools: TOOLS, tool_choice: { type: "tool", name: "   " } })),
      'requires a non-empty tool "name"',
    );
    expectInvalid(
      () => parse(requestBody({ tools: TOOLS, tool_choice: { type: "tool", name: "missing" } })),
      'names unknown tool "missing"',
    );
    expectInvalid(
      () => parse(requestBody({ tool_choice: { type: "tool", name: "search" } })),
      'names unknown tool "search"',
    );
  });
});

describe("parseAnthropicRequest: system prompt", () => {
  test("string system prompt is kept verbatim", () => {
    expect(parse(requestBody({ system: "Be terse." })).system).toBe("Be terse.");
    expect(parse(requestBody()).system).toBe("");
  });

  test("system blocks are joined with a blank line", () => {
    const parsed = parse(
      requestBody({
        system: [
          { type: "text", text: "first" },
          { type: "text", text: "second", cache_control: { type: "ephemeral" } },
        ],
      }),
    );
    expect(parsed.system).toBe("first\n\nsecond");
  });

  test("leading system-role messages are absorbed into the system prompt", () => {
    const parsed = parse(
      requestBody({
        system: "top",
        messages: [
          { role: "system", content: "from a translated client" },
          { role: "system", content: [{ type: "text", text: "second system" }] },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(parsed.system).toBe("top\n\nfrom a translated client\n\nsecond system");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
  });

  test("leading developer messages are absorbed like system messages", () => {
    const parsed = parse(
      requestBody({
        system: "top",
        messages: [
          { role: "system", content: "from a translated client" },
          { role: "developer", content: [{ type: "text", text: "developer instructions" }] },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(parsed.system).toBe("top\n\nfrom a translated client\n\ndeveloper instructions");
    expect(parsed.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("mid-conversation system/developer messages become reminder-shaped user parts", () => {
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "system", content: "cwd changed to /tmp" },
          {
            role: "developer",
            content: [{ type: "text", text: "<task-notification>done</task-notification>" }],
          },
          { role: "user", content: "next" },
        ],
      }),
    );
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    // Adjacent user turns merge, so the reminders ride the trailing user message.
    expect(parsed.messages[2]?.content).toEqual([
      { type: "text", text: "<system-reminder>\ncwd changed to /tmp\n</system-reminder>" },
      {
        type: "text",
        text: "<system-reminder>\n<task-notification>done</task-notification>\n</system-reminder>",
      },
      { type: "text", text: "next" },
    ]);
  });

  test("skips tool_addition and tool_removal blocks in system messages cleanly", () => {
    const parsed = parse(
      requestBody({
        system: "base instructions",
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "dynamic instruction" },
              { type: "tool_addition", tool: { name: "new_tool" } },
              { type: "tool_removal", tool_name: "old_tool" },
            ],
          },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(parsed.system).toBe("base instructions\n\ndynamic instruction");
    expect(parsed.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("reminders are not double-wrapped and queued user messages are unwrapped", () => {
    const wrapped = "<system-reminder>\nUse tabs.\n</system-reminder>";
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: wrapped },
          {
            role: "developer",
            content:
              "<system-reminder>\nThe user sent a new message while you were working:\nplease also fix the tests\n</system-reminder>",
          },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: wrapped },
      // Genuine steering: the envelope is stripped so the coordinator sees the
      // user's own words instead of an anonymous reminder.
      { type: "text", text: "please also fix the tests" },
    ]);
  });

  test("an empty mid-conversation system message contributes nothing", () => {
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "   " },
        ],
      }),
    );
    expect(parsed.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("a conversation made only of system messages has no user turn", () => {
    expectInvalid(
      () => parse(requestBody({ messages: [{ role: "system", content: "only system" }] })),
      "messages",
    );
  });
});

describe("parseAnthropicRequest: messages & content parts", () => {
  test("messages must be a non-empty array with valid roles", () => {
    expectInvalid(() => parse(requestBody({ messages: [] })), "messages must be a non-empty array");
    expectInvalid(() => parse(requestBody({ messages: undefined })), "messages");
    expectInvalid(
      () => parse(requestBody({ messages: [{ role: "tool", content: "x" }] })),
      "Unsupported message role",
    );
    expectInvalid(
      () => parse(requestBody({ messages: [{ role: "user", content: 7 }] })),
      "must be a string or an array",
    );
  });

  test("string content becomes a text part", () => {
    const parsed = parse(requestBody({ messages: [{ role: "assistant", content: "done" }] }));
    expect(parsed.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("adjacent same-role messages are merged", () => {
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "c" },
          { role: "assistant", content: [{ type: "text", text: "d" }] },
          { role: "user", content: "e" },
        ],
      }),
    );
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(parsed.messages[0]?.content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(parsed.messages[1]?.content).toEqual([
      { type: "text", text: "c" },
      { type: "text", text: "d" },
    ]);
    expect(parsed.messages[2]?.content).toEqual([{ type: "text", text: "e" }]);
  });

  test("base64 images are accepted with their media type", () => {
    const parsed = parse(
      requestBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              },
            ],
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });

  test("URL images, unsupported media types and bogus base64 are rejected", () => {
    const imageMessage = (source: Record<string, unknown>) =>
      requestBody({ messages: [{ role: "user", content: [{ type: "image", source }] }] });

    expectInvalid(
      () => parse(imageMessage({ type: "url", url: "https://example.com/cat.png" })),
      "URL image sources are not supported",
    );
    expectInvalid(
      () =>
        parse(
          imageMessage({ type: "base64", media_type: "image/tiff", data: "iVBORw0KGgo=" }),
        ),
      "unsupported image media type",
    );
    expectInvalid(
      () => parse(imageMessage({ type: "base64", media_type: "image/png", data: "   " })),
      "non-empty",
    );
    expectInvalid(
      () => parse(imageMessage({ type: "base64", media_type: "image/png", data: "not base64!" })),
      "valid base64",
    );
    expectInvalid(
      () => parse(imageMessage({ type: "file", file_id: "file_123" })),
      "unsupported image source type",
    );
  });

  test("plain-text documents become text, PDF/binary/URL documents are rejected", () => {
    const documentMessage = (block: Record<string, unknown>) =>
      requestBody({ messages: [{ role: "user", content: [block] }] });

    const parsed = parse(
      documentMessage({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "fact sheet" },
      }),
    );
    expect(parsed.messages[0]?.content).toEqual([{ type: "text", text: "fact sheet" }]);

    expectInvalid(
      () =>
        parse(
          documentMessage({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
          }),
        ),
      "Binary documents",
    );
    expectInvalid(
      () =>
        parse(
          documentMessage({
            type: "document",
            source: { type: "url", url: "https://example.com/doc.pdf" },
          }),
        ),
      "URL document sources are not supported",
    );
  });

  test("thinking blocks are normalized and redacted_thinking is skipped", () => {
    const parsed = parse(
      requestBody({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig-abc" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig-abc" },
      { type: "text", text: "answer" },
    ]);
  });

  test("tool_use and tool_result blocks round-trip", () => {
    const parsed = parse(
      requestBody({
        messages: [
          {
            role: "user",
            content: "run it",
          },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } },
              { type: "tool_use", id: "toolu_2", name: "browse", input: null },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                is_error: true,
                content: [
                  { type: "text", text: "boom" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" },
                  },
                ],
              },
              { type: "tool_result", tool_use_id: "toolu_2", content: "plain" },
            ],
          },
        ],
      }),
    );

    expect(parsed.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } },
      { type: "tool_use", id: "toolu_2", name: "browse", input: {} },
    ]);
    expect(parsed.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "toolu_1",
        isError: true,
        content: [
          { type: "text", text: "boom" },
          { type: "image", mediaType: "image/jpeg", data: "/9j/4AAQ" },
        ],
      },
      {
        type: "tool_result",
        toolUseId: "toolu_2",
        isError: false,
        content: [{ type: "text", text: "plain" }],
      },
    ]);
  });

  test("tool_result images get the same strict base64/media-type validation", () => {
    const toolResult = (block: Record<string, unknown>) =>
      requestBody({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [block] }],
          },
        ],
      });

    expectInvalid(
      () =>
        parse(
          toolResult({
            type: "image",
            source: { type: "url", url: "https://example.com/x.png" },
          }),
        ),
      "URL image sources are not supported",
    );
    expectInvalid(
      () =>
        parse(
          toolResult({
            type: "image",
            source: { type: "base64", media_type: "image/heic", data: "AAAA" },
          }),
        ),
      "unsupported image media type",
    );
  });

  test("misplaced or malformed tool blocks are rejected", () => {
    expectInvalid(
      () =>
        parse(
          requestBody({
            messages: [
              { role: "user", content: [{ type: "tool_use", id: "toolu_1", name: "x" }] },
            ],
          }),
        ),
      "tool_use blocks are only valid in assistant messages",
    );
    expectInvalid(
      () =>
        parse(
          requestBody({
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }],
              },
            ],
          }),
        ),
      "tool_result blocks are only valid in user messages",
    );
    expectInvalid(
      () =>
        parse(
          requestBody({
            messages: [
              { role: "assistant", content: [{ type: "tool_use", name: "x", input: {} }] },
            ],
          }),
        ),
      "non-empty \"id\"",
    );
    expectInvalid(
      () =>
        parse(
          requestBody({ messages: [{ role: "user", content: [{ type: "audio" }] }] }),
        ),
      "Unsupported content block type",
    );
  });
});

describe("parseAnthropicRequest: Claude Code ToolSearch & server-tool blocks", () => {
  test("tool_reference in tool_result content becomes readable text", () => {
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: "find a tool" },
          {
            role: "assistant",
            content: [{ type: "server_tool_use", name: "tool_search", input: { query: "jira" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_search",
                content: [
                  { type: "tool_reference", tool_name: "jira_create_issue" },
                  { type: "tool_reference" },
                  { type: "tool_addition", tool_name: "jira" },
                  { type: "tool_removal", tool_name: "obsolete" },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.messages[1]?.content).toEqual([
      { type: "text", text: 'Tool call: tool_search {"query":"jira"}' },
    ]);
    // tool_addition/tool_removal are no-ops: they only describe catalog deltas.
    expect(parsed.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "toolu_search",
        isError: false,
        content: [
          { type: "text", text: "Loaded tool: jira_create_issue" },
          { type: "text", text: "Loaded tool: unknown" },
        ],
      },
    ]);
  });

  test("search and server-tool result blocks render as text in message content", () => {
    const parsed = parse(
      requestBody({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "search_result",
                title: "Docs",
                source: "https://example.com",
                content: [{ type: "text", text: "Snippet" }],
              },
              { type: "web_search_tool_result", content: [{ type: "text", text: "Result A" }] },
              { type: "mcp_tool_result", content: "mcp says hi" },
              { type: "code_execution_tool_result", content: [{ type: "text", text: "42" }] },
              { type: "tool_removal", tool_name: "gone" },
              { type: "text", text: "after" },
            ],
          },
        ],
      }),
    );

    expect(parsed.messages[0]?.content).toEqual([
      { type: "text", text: "Search result: Docs\nSource: https://example.com\nSnippet" },
      { type: "text", text: "Web search results:\nResult A" },
      { type: "text", text: "MCP tool result:\nmcp says hi" },
      { type: "text", text: "Code execution result:\n42" },
      { type: "text", text: "after" },
    ]);
  });

  test("a search_result without title/source still renders its content", () => {
    const parsed = parse(
      requestBody({
        messages: [
          { role: "user", content: [{ type: "search_result", content: "just text" }] },
        ],
      }),
    );
    expect(parsed.messages[0]?.content).toEqual([
      { type: "text", text: "Search result\njust text" },
    ]);
  });
});

describe("parseAnthropicRequest: tools", () => {
  test("tool schemas come from input_schema, parameters, or the empty object schema", () => {
    const parsed = parse(
      requestBody({
        tools: [
          { name: "search", description: "web search", input_schema: { type: "object" } },
          { name: "legacy", parameters: { type: "object", properties: { q: {} } } },
          { name: "bare" },
        ],
      }),
    );
    expect(parsed.tools).toEqual([
      { name: "search", description: "web search", inputSchema: { type: "object" } },
      {
        name: "legacy",
        inputSchema: { type: "object", properties: { q: {} } },
      },
      { name: "bare", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  test("server-side tools without a schema are rejected cleanly", () => {
    expectInvalid(
      () => parse(requestBody({ tools: [{ type: "web_search_20250305" }] })),
      "Server tool",
    );
    expectInvalid(
      () =>
        parse(
          requestBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
        ),
      "Server tool",
    );
    expectInvalid(() => parse(requestBody({ tools: [{}] })), 'tools[0] must include a non-empty "name"');
    expectInvalid(() => parse(requestBody({ tools: "nope" })), "tools must be an array");
  });
});

describe("parseAnthropicRequest: session & metadata", () => {
  test("session id header is trimmed, blank headers become null", () => {
    expect(SESSION_ID_HEADER).toBe("x-agy-session-id");
    expect(ALT_SESSION_ID_HEADER).toBe("x-magpie-session");
    expect(parse(requestBody(), {}, { [SESSION_ID_HEADER]: "  sess-1  " }).sessionId).toBe("sess-1");
    expect(parse(requestBody(), {}, { [SESSION_ID_HEADER]: "   " }).sessionId).toBe(null);
    expect(parse(requestBody()).sessionId).toBe(null);
    expect(parse(requestBody(), {}, { [ALT_SESSION_ID_HEADER]: "  magpie-sess-1  " }).sessionId).toBe(
      "magpie-sess-1",
    );
    expect(
      parse(
        requestBody(),
        {},
        { [SESSION_ID_HEADER]: "primary-sess", [ALT_SESSION_ID_HEADER]: "fallback-sess" },
      ).sessionId,
    ).toBe("primary-sess");
  });

  test("metadata.user_id and max_tokens are forwarded", () => {
    const parsed = parse(
      requestBody({ metadata: { user_id: "user-42" }, max_tokens: 512.9 }),
    );
    expect(parsed.userId).toBe("user-42");
    expect(parsed.maxTokens).toBe(512);
    expect(parse(requestBody()).userId).toBeUndefined();
    expect(parse(requestBody({ max_tokens: "many" })).maxTokens).toBeUndefined();
  });

  test("subagent and workdir headers are forwarded, blanks become undefined", () => {
    expect(SUBAGENT_HEADER).toBe("x-magpie-subagent");
    expect(ALT_SUBAGENT_HEADER).toBe("x-claude-code-agent-id");
    expect(WORKDIR_HEADER).toBe("x-magpie-work-dir");

    const both = parse(
      requestBody(),
      {},
      { [SUBAGENT_HEADER]: "  agent-7  ", [WORKDIR_HEADER]: " /tmp/repo " },
    );
    expect(both.subagentId).toBe("agent-7");
    expect(both.workDir).toBe("/tmp/repo");

    // Claude Code's own header is the fallback; the magpie header wins.
    expect(
      parse(requestBody(), {}, { [ALT_SUBAGENT_HEADER]: "agent-9" }).subagentId,
    ).toBe("agent-9");
    expect(
      parse(
        requestBody(),
        {},
        { [SUBAGENT_HEADER]: "primary", [ALT_SUBAGENT_HEADER]: "fallback" },
      ).subagentId,
    ).toBe("primary");

    const blank = parse(
      requestBody(),
      {},
      { [SUBAGENT_HEADER]: "   ", [ALT_SUBAGENT_HEADER]: " ", [WORKDIR_HEADER]: "  " },
    );
    expect(blank.subagentId).toBeUndefined();
    expect(blank.workDir).toBeUndefined();
    expect(parse(requestBody()).subagentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Thinking signatures
// ---------------------------------------------------------------------------

describe("thinking signature", () => {
  // A client keeps and replays a thinking block only with a signature, but a real
  // Anthropic endpoint answers 400 to one it did not issue. Magpie's preventive
  // filter drops empty and UUID-shaped signatures before a Claude route
  // (`deepseekSignature`), so a UUID is the shape that lets a client keep the
  // summary while Magpie still removes it.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("is UUID-shaped, stable in its inputs, and distinct for other inputs", () => {
    const signature = thinkingSignatureFor("sess-1", "pondering");
    expect(signature).toMatch(UUID);
    expect(thinkingSignatureFor("sess-1", "pondering")).toBe(signature);
    expect(thinkingSignatureFor("sess-2", "pondering")).not.toBe(signature);
    expect(thinkingSignatureFor("sess-1", "different")).not.toBe(signature);
    // The block opens without one: a client adds each delta to the value it has.
    expect(OPENING_THINKING_SIGNATURE).toBe("");
  });
});

// ---------------------------------------------------------------------------
// jsonErrorResponse
// ---------------------------------------------------------------------------

describe("jsonErrorResponse", () => {
  test("maps BridgeHttpError to its own status and Anthropic error shape", async () => {
    const response = jsonErrorResponse(
      new BridgeHttpError(409, "invalid_request_error", "session busy"),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await readJson(response)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "session busy" },
    });
  });

  test("falls back to 502 api_error for anything else", async () => {
    const response = jsonErrorResponse(new Error("kaboom"));
    expect(response.status).toBe(502);
    expect(await readJson(response)).toEqual({
      type: "error",
      error: { type: "api_error", message: "kaboom" },
    });
    const opaque = jsonErrorResponse("just a string");
    expect(opaque.status).toBe(502);
    expect(asRecord((await readJson(opaque)).error).type).toBe("api_error");
  });

  test("a 401 authentication error marks the account sign-in expired", async () => {
    expect(SIGN_IN_HEADER).toBe("x-magpie-sign-in");
    const response = jsonErrorResponse(
      new BridgeHttpError(401, "authentication_error", "token expired"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get(SIGN_IN_HEADER)).toBe("expired");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("an explicit signInExpired flag is honoured off 401 too", () => {
    const response = jsonErrorResponse(
      new BridgeHttpError(403, "permission_error", "account revoked", { signInExpired: true }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get(SIGN_IN_HEADER)).toBe("expired");
  });

  test("ordinary errors carry no sign-in header", () => {
    expect(
      jsonErrorResponse(new BridgeHttpError(429, "rate_limit_error", "slow down")).headers.get(
        SIGN_IN_HEADER,
      ),
    ).toBe(null);
    expect(jsonErrorResponse(new Error("kaboom")).headers.get(SIGN_IN_HEADER)).toBe(null);
    expect(
      jsonErrorResponse(new BridgeHttpError(400, "invalid_request_error", "bad")).headers.get(
        SIGN_IN_HEADER,
      ),
    ).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// encodeAnthropicSseResponse
// ---------------------------------------------------------------------------

describe("encodeAnthropicSseResponse: pre-stream failures keep their HTTP status", () => {
  test("409/429/503 error events return real JSON error responses, not 200 SSE", async () => {
    for (const [status, errorType] of [
      [409, "invalid_request_error"],
      [429, "rate_limit_error"],
      [503, "overloaded_error"],
      [401, "authentication_error"],
    ] as const) {
      const response = await encodeAnthropicSseResponse(
        MODEL,
        streamOf([
          { type: "error", status, errorType, message: "pool exhausted" },
          { type: "text_delta", text: "never reached" },
        ]),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = await readJson(response);
      expect(body.type).toBe("error");
      expect(asRecord(body.error).type).toBe(errorType);
      expect(asRecord(body.error).message).toBe("pool exhausted");
    }
  });

  test("a thrown BridgeHttpError before any content keeps its status", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamThatFailsAfter([], new BridgeHttpError(503, "overloaded_error", "all slots busy")),
    );
    expect(response.status).toBe(503);
    expect(asRecord((await readJson(response)).error).message).toBe("all slots busy");
  });

  test("a thrown non-Bridge error before any content becomes 502 api_error", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamThatFailsAfter([], new Error("socket exploded")),
    );
    expect(response.status).toBe(502);
    expect(asRecord((await readJson(response)).error).message).toBe("socket exploded");
  });

  test("a pre-stream auth error event adds x-magpie-sign-in: expired", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        {
          type: "error",
          status: 401,
          errorType: "authentication_error",
          message: "please sign in again",
          signInExpired: true,
        },
      ]),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get(SIGN_IN_HEADER)).toBe("expired");
    expect(asRecord((await readJson(response)).error).type).toBe("authentication_error");
  });

  test("a non-401 signInExpired event still marks the sign-in expired", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        {
          type: "error",
          status: 500,
          errorType: "api_error",
          message: "credential rejected upstream",
          signInExpired: true,
        },
      ]),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get(SIGN_IN_HEADER)).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// encodeAnthropicSseResponse: upstream lifecycle
// ---------------------------------------------------------------------------

/**
 * A coordinator-shaped turn: the session lock is taken before the first yield
 * and only dropped in `finally`, so anything that walks away from the iterator
 * without releasing it holds the lock forever. `state` is owned per test — a
 * shared counter would hide a missed release behind a sibling's teardown.
 */
function lockedTurn(
  state: { finalized: number },
  text = "never read",
): AsyncGenerator<TurnStreamEvent> {
  return (async function* (): AsyncGenerator<TurnStreamEvent> {
    try {
      yield { type: "text_delta", text };
      yield { type: "finish", stopReason: "end_turn", usage: USAGE };
    } finally {
      state.finalized += 1;
    }
  })();
}

/** Waits (bounded) for a released upstream to run its `finally` block. */
async function settle(state: { finalized: number }): Promise<void> {
  for (let tick = 0; tick < 50 && state.finalized === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("encodeAnthropicSseResponse: upstream teardown", () => {
  test("a pre-stream error event runs the upstream generator's finally block", async () => {
    const state = { finalized: false, lockReleased: false, ranPastError: false };
    async function* lockedErrorTurn(): AsyncGenerator<TurnStreamEvent> {
      // Mirrors SessionCoordinator.executeTurn: a lock is taken before the first
      // yield and only dropped in `finally`.
      try {
        yield {
          type: "error",
          status: 429,
          errorType: "rate_limit_error",
          message: "pool exhausted",
        };
        state.ranPastError = true;
        yield { type: "text_delta", text: "never reached" };
      } finally {
        state.finalized = true;
        state.lockReleased = true;
      }
    }

    const response = await encodeAnthropicSseResponse(MODEL, lockedErrorTurn());
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(asRecord((await readJson(response)).error).message).toBe("pool exhausted");

    // Awaiting the response must release the iterated turn: a generator left
    // suspended at its `yield` would hold the coordinator's session lock forever.
    expect(state.finalized).toBe(true);
    expect(state.lockReleased).toBe(true);
    expect(state.ranPastError).toBe(false);
  });

  test("an awaited response leaves zero abort listeners and a late abort cannot double-cancel", async () => {
    const tracker = trackingSignal();
    const events: TurnStreamEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "finish", stopReason: "end_turn", usage: USAGE },
    ];
    const state = { pulled: 0, returns: 0, completed: false };
    const iterable: AsyncIterable<TurnStreamEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<TurnStreamEvent>> {
            state.pulled += 1;
            const value = events[index];
            if (value === undefined) {
              state.completed = true;
              return { done: true, value: undefined };
            }
            index += 1;
            return { done: false, value };
          },
          async return(): Promise<IteratorResult<TurnStreamEvent>> {
            state.returns += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };

    const response = await encodeAnthropicSseResponse(MODEL, iterable, tracker.signal);
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    expect(frames[frames.length - 1]?.event).toBe("message_stop");

    // The single claimed body registers exactly one listener and detaches it
    // when the stream finishes.
    expect(tracker.listenerCount()).toBe(0);
    expect(state.returns).toBe(1);

    // Aborting after completion must not reach the source again.
    tracker.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.returns).toBe(1);
    expect(tracker.listenerCount()).toBe(0);
  });

  test("an awaited response cancelled before its first read releases the upstream", async () => {
    const tracker = trackingSignal();
    const state = { finalized: 0 };
    let bodyCancels = 0;

    // The host records the body of an unconsumed response and cancels it when
    // downstream disconnects, so an unread response must still release the turn
    // (an unreleased generator holds its session lock forever).
    const response = await encodeAnthropicSseResponse(
      MODEL,
      lockedTurn(state),
      tracker.signal,
      () => {
        bodyCancels += 1;
      },
    );
    await response.body?.cancel();

    await settle(state);
    expect(state.finalized).toBe(1);
    expect(bodyCancels).toBe(1);
    expect(tracker.listenerCount()).toBe(0);
  });

  test("an awaited response aborted before its first read releases the upstream", async () => {
    const tracker = trackingSignal();
    const state = { finalized: 0 };

    await encodeAnthropicSseResponse(MODEL, lockedTurn(state), tracker.signal);
    expect(tracker.listenerCount()).toBe(1);
    tracker.abort();

    await settle(state);
    expect(state.finalized).toBe(1);
    expect(tracker.listenerCount()).toBe(0);
  });

  test("an awaited response cancelled before its first pull still releases the turn", async () => {
    const state = { finalized: 0 };

    // The body is handed out by the await; a host that cancels it without ever
    // reading has to release the turn rather than wait for a `pull()` that
    // never comes.
    const response = await encodeAnthropicSseResponse(MODEL, lockedTurn(state));
    expect(response.status).toBe(200);
    await response.body?.cancel();

    await settle(state);
    expect(state.finalized).toBe(1);
  });

  test("a response read after a delay still streams the whole turn", async () => {
    const state = { finalized: 0 };

    const response = await encodeAnthropicSseResponse(MODEL, lockedTurn(state, "kept"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const frames = parseSseFrames(await response.text());

    expect(frames[0]?.event).toBe("message_start");
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
    expect(state.finalized).toBe(1);
  });

  test("aborting mid-stream releases the upstream exactly once", async () => {
    const tracker = trackingSignal();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { finalized: 0 };

    async function* gatedTurn(): AsyncGenerator<TurnStreamEvent> {
      try {
        yield { type: "text_delta", text: "first" };
        entered = true;
        await gate;
        yield { type: "finish", stopReason: "end_turn", usage: USAGE };
      } finally {
        state.finalized += 1;
      }
    }

    const response = await encodeAnthropicSseResponse(MODEL, gatedTurn(), tracker.signal);
    const payload = response.text();

    for (let i = 0; i < 50 && !entered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(entered).toBe(true);
    expect(tracker.listenerCount()).toBe(1);

    tracker.abort();
    release();
    const body = await payload;
    expect(body).not.toContain("message_stop");
    expect(tracker.listenerCount()).toBe(0);
    // The abort listener released the source synchronously, but the queued
    // `iterator.return()` can only run once the in-flight `next()` settles; on
    // Bun 1.4.4 that lands one microtask turn after `response.text()` resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.finalized).toBe(1);
  });

  test("a finish event lets the upstream generator run past its yield to natural completion", async () => {
    const state = { committedAfterFinish: false, text: "" };
    async function* coordinatingTurn(): AsyncGenerator<TurnStreamEvent> {
      yield { type: "text_delta", text: "answer" };
      yield { type: "finish", stopReason: "end_turn", usage: USAGE };
      // The coordinator commits its ledger after `yield finish`; unwinding from
      // inside the yield with iterator.return() would skip this entirely.
      state.text = "answer";
      state.committedAfterFinish = true;
    }

    const response = await encodeAnthropicSseResponse(MODEL, coordinatingTurn());
    const frames = parseSseFrames(await response.text());
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
    expect(state.committedAfterFinish).toBe(true);
    expect(state.text).toBe("answer");
  });

  test("an upstream that stalls after finish cannot block stream teardown", async () => {
    let finalized = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* stallsAfterFinish(): AsyncGenerator<TurnStreamEvent> {
      try {
        yield { type: "finish", stopReason: "end_turn", usage: USAGE };
        await gate;
        yield { type: "text_delta", text: "late" };
      } finally {
        finalized = true;
      }
    }

    const response = await encodeAnthropicSseResponse(MODEL, stallsAfterFinish());
    const frames = parseSseFrames(await response.text());
    expect(frames[frames.length - 1]?.event).toBe("message_stop");

    // Releasing the stalled turn lets the queued return() finish its finally.
    release();
    for (let i = 0; i < 50 && !finalized; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(finalized).toBe(true);
  });

  test("aborting while the turn is still peeking answers 499 JSON and releases the upstream", async () => {
    const tracker = trackingSignal();
    const state = { entered: false, finalized: 0 };
    let releasePeek!: () => void;
    const peekGate = new Promise<void>((resolve) => {
      releasePeek = resolve;
    });

    // The first event only arrives after the gate: the caller hangs up while
    // `peekFirst()` is still waiting on upstream, the slowest possible start.
    async function* slowStart(): AsyncGenerator<TurnStreamEvent> {
      try {
        state.entered = true;
        await peekGate;
        yield { type: "text_delta", text: "unread" };
        yield { type: "finish", stopReason: "end_turn", usage: USAGE };
      } finally {
        state.finalized += 1;
      }
    }

    const pending = encodeAnthropicSseResponse(MODEL, slowStart(), tracker.signal);
    for (let i = 0; i < 50 && !state.entered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(state.entered).toBe(true);

    tracker.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(asRecord((await readJson(response)).error).type).toBe("invalid_request_error");
    expect(tracker.listenerCount()).toBe(0);

    // The generator is parked mid-await; releasing it lets the queued
    // `iterator.return()` run its finally block.
    releasePeek();
    await settle(state);
    expect(state.finalized).toBe(1);
  });
});

describe("encodeAnthropicSseResponse: frame encoding", () => {
  test("streams thinking then text blocks with Anthropic-valid framing", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "let me " },
        { type: "thinking_delta", thinking: "think" },
        { type: "thinking_signature", signature: "sig-real" },
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const frames = parseSseFrames(await response.text());
    const order = frames.map((frame) => frame.event);

    expect(order[0]).toBe("message_start");
    expect(order[order.length - 1]).toBe("message_stop");

    const start = frames[0];
    if (start === undefined) throw new Error("missing message_start");
    const message = asRecord(start.data.message);
    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.model).toBe(MODEL);
    expect(message.stop_reason).toBe(null);
    expect(String(message.id).startsWith("msg_")).toBe(true);

    const thinkingStart = requireFrame(
      frames,
      "content_block_start",
      (data) => asRecord(data.content_block).type === "thinking",
    );
    expect(thinkingStart.data.index).toBe(0);

    const thinkingDeltas = frames.filter(
      (frame) =>
        frame.event === "content_block_delta" &&
        asRecord(frame.data.delta).type === "thinking_delta",
    );
    expect(thinkingDeltas.map((frame) => asRecord(frame.data.delta).thinking)).toEqual([
      "let me ",
      "think",
    ]);

    const signatureDelta = requireFrame(
      frames,
      "content_block_delta",
      (data) => asRecord(data.delta).type === "signature_delta",
    );
    expect(asRecord(signatureDelta.data.delta).signature).toBe("sig-real");

    const textStart = requireFrame(
      frames,
      "content_block_start",
      (data) => asRecord(data.content_block).type === "text",
    );
    expect(textStart.data.index).toBe(1);

    const stops = frames
      .filter((frame) => frame.event === "content_block_stop")
      .map((frame) => frame.data.index);
    expect(stops).toEqual([0, 1]);

    const messageDelta = requireFrame(frames, "message_delta");
    expect(asRecord(messageDelta.data.delta).stop_reason).toBe("end_turn");
    expect(asRecord(messageDelta.data.delta).stop_sequence).toBe(null);
    expect(asRecord(messageDelta.data.usage)).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });
  });

  test("the thinking block opens with the signature field already present", async () => {
    // Magpie's own encoder writes `signature: ""` at the block's start
    // (`internal/gateway/anthropic.go:1696-1705`): a client that reads the start
    // record alone must not find the field missing, and one that only looks for a
    // later delta must not be the only path that sees it.
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "plan" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    const frames = parseSseFrames(await response.text());
    const start = requireFrame(
      frames,
      "content_block_start",
      (data) => asRecord(data.content_block).type === "thinking",
    );
    const block = asRecord(start.data.content_block);
    expect(block.signature).toBe(OPENING_THINKING_SIGNATURE);
    expect(block.thinking).toBe("");
  });

  test("a thinking block without an upstream signature gets a UUID-shaped one", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "internal monologue" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    const frames = parseSseFrames(await response.text());
    const signatureDelta = requireFrame(
      frames,
      "content_block_delta",
      (data) => asRecord(data.delta).type === "signature_delta",
    );
    expect(String(asRecord(signatureDelta.data.delta).signature)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("tool_use blocks produce input_json_delta that parses back to the input", async () => {
    const input = { query: "cats", options: { limit: 2, nested: [1, 2, 3] } };
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "tool_use", id: "toolu_abc", name: "search", input },
        { type: "finish", stopReason: "tool_use", usage: USAGE },
      ]),
    );
    const frames = parseSseFrames(await response.text());

    const blockStart = requireFrame(
      frames,
      "content_block_start",
      (data) => asRecord(data.content_block).type === "tool_use",
    );
    const contentBlock = asRecord(blockStart.data.content_block);
    expect(contentBlock.id).toBe("toolu_abc");
    expect(contentBlock.name).toBe("search");
    expect(contentBlock.input).toEqual({});

    const jsonDelta = requireFrame(
      frames,
      "content_block_delta",
      (data) => asRecord(data.delta).type === "input_json_delta",
    );
    const partialJson = String(asRecord(jsonDelta.data.delta).partial_json);
    expect(JSON.parse(partialJson)).toEqual(input);

    const messageDelta = requireFrame(frames, "message_delta");
    expect(asRecord(messageDelta.data.delta).stop_reason).toBe("tool_use");
  });

  test("a mid-stream error emits an error frame and terminates cleanly without leaking timers", async () => {
    let frames: SseFrame[] = [];
    let status = 0;
    const tracked = trackedStream([
      { type: "text_delta", text: "partial answer" },
      { type: "error", status: 503, errorType: "overloaded_error", message: "worker died" },
    ]);
    const stats = await withIntervalTracking(async () => {
      const response = await encodeAnthropicSseResponse(MODEL, tracked.iterable);
      status = response.status;
      frames = parseSseFrames(await response.text());
    });

    expect(status).toBe(200);
    const last = frames[frames.length - 1];
    if (last === undefined) throw new Error("expected SSE frames");
    expect(last.event).toBe("error");
    expect(last.data.type).toBe("error");
    expect(asRecord(last.data.error).type).toBe("overloaded_error");
    expect(asRecord(last.data.error).message).toBe("worker died");
    expect(frames.some((frame) => frame.event === "message_stop")).toBe(false);

    expect(stats.created).toBe(1);
    expect(stats.cleared).toBe(1);
    expect(stats.outstanding).toBe(0);
    // The upstream turn must be torn down, not left suspended at a yield.
    expect(tracked.state.returned).toBe(true);
  });

  test("an exception after content started is reported in-stream", async () => {
    const stats = await withIntervalTracking(async () => {
      const response = await encodeAnthropicSseResponse(
        MODEL,
        streamThatFailsAfter(
          [{ type: "text_delta", text: "hi" }],
          new BridgeHttpError(429, "rate_limit_error", "quota blown mid-turn"),
        ),
      );
      const frames = parseSseFrames(await response.text());
      const last = frames[frames.length - 1];
      if (last === undefined) throw new Error("expected SSE frames");
      expect(last.event).toBe("error");
      expect(asRecord(last.data.error).type).toBe("rate_limit_error");
      expect(asRecord(last.data.error).message).toBe("quota blown mid-turn");
    });
    expect(stats.created).toBe(stats.cleared);
    expect(stats.outstanding).toBe(0);
  });

  test("an upstream that ends without a finish event still closes the message", async () => {
    const tracked = trackedStream([{ type: "text_delta", text: "cut off" }]);
    const response = await encodeAnthropicSseResponse(MODEL, tracked.iterable);
    const frames = parseSseFrames(await response.text());
    const delta = requireFrame(frames, "message_delta");
    expect(asRecord(delta.data.delta).stop_reason).toBe("end_turn");
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
    expect(tracked.state.completed).toBe(true);
    expect(tracked.state.returned).toBe(true);
  });

  test("awaiting the call resolves to one standard Response carrying the SSE body", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "text_delta", text: "y" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const frames = parseSseFrames(await response.text());
    expect(frames[0]?.event).toBe("message_start");
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
  });

  test("a pre-aborted signal answers 499 JSON without touching the upstream", async () => {
    const controller = new AbortController();
    controller.abort();
    const tracked = trackedStream([{ type: "text_delta", text: "one" }]);

    const response = await encodeAnthropicSseResponse(MODEL, tracked.iterable, controller.signal);
    expect(response.status).toBe(499);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await readJson(response)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Client closed request" },
    });
    // No SSE frames at all, and the turn is torn down rather than left unread.
    expect(tracked.state.pulled).toBe(0);
    expect(tracked.state.returned).toBe(true);
  });

  test("a signature-only first event still yields a clean 200 message", async () => {
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "thinking_signature", signature: "sig-orphan" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    expect(frames[0]?.event).toBe("message_start");
    // Ensures at least one empty text content_block is emitted on end_turn
    // so OpenAI/Responses translators never see a zero-item SSE message.
    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(asRecord(starts[0]!.data.content_block).type).toBe("text");
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
  });

  test("a late signature does not reopen or corrupt the thinking block", async () => {
    // The runtime emits its signature at the end of the turn, after text.
    const response = await encodeAnthropicSseResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "plan" },
        { type: "text_delta", text: "answer" },
        { type: "thinking_signature", signature: "sig-late" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    const frames = parseSseFrames(await response.text());

    const starts = frames.filter((frame) => frame.event === "content_block_start");
    expect(starts).toHaveLength(2);

    const signatureDeltas = frames.filter(
      (frame) =>
        frame.event === "content_block_delta" &&
        asRecord(frame.data.delta).type === "signature_delta",
    );
    expect(signatureDeltas).toHaveLength(1);
    const signatureDelta = signatureDeltas[0];
    if (signatureDelta === undefined) throw new Error("missing signature_delta");
    expect(signatureDelta.data.index).toBe(0);
    expect(String(asRecord(signatureDelta.data.delta).signature)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("keeps the connection warm with ping frames while the upstream is silent", async () => {
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
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* gated(): AsyncGenerator<TurnStreamEvent> {
        yield { type: "text_delta", text: "start" };
        await gate;
        yield { type: "finish", stopReason: "end_turn", usage: USAGE };
      }

      const response = await encodeAnthropicSseResponse(MODEL, gated());
      const payload = response.text();

      // Let the pump reach the silent upstream, then fire the heartbeat.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const heartbeat = heartbeats[0];
      if (heartbeat === undefined) {
        throw new Error("expected a heartbeat interval to be scheduled");
      }
      heartbeat();
      release();

      const frames = parseSseFrames(await payload);
      const ping = requireFrame(frames, "ping");
      expect(ping.data.type).toBe("ping");
      // The ping lands after the first content delta but before completion.
      const pingIndex = frames.indexOf(ping);
      const stopIndex = frames.findIndex((frame) => frame.event === "message_stop");
      expect(pingIndex).toBeGreaterThan(0);
      expect(pingIndex).toBeLessThan(stopIndex);
      expect(cleared).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});

// ---------------------------------------------------------------------------
// collectAnthropicJsonResponse
// ---------------------------------------------------------------------------

describe("collectAnthropicJsonResponse", () => {
  test("builds a spec-shaped Messages response with thinking, text and tool_use blocks", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "step 1" },
        { type: "thinking_delta", thinking: " then 2" },
        { type: "thinking_signature", signature: "sig-json" },
        { type: "text_delta", text: "Searching" },
        { type: "text_delta", text: "..." },
        { type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } },
        { type: "finish", stopReason: "tool_use", usage: USAGE },
      ]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const body = await readJson(response);
    expect(String(body.id).startsWith("msg_")).toBe(true);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe(MODEL);
    expect(body.stop_reason).toBe("tool_use");
    expect(body.stop_sequence).toBe(null);
    expect(body.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });
    expect(body.content).toEqual([
      { type: "thinking", thinking: "step 1 then 2", signature: "sig-json" },
      { type: "text", text: "Searching..." },
      { type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } },
    ]);
  });

  test("an empty end_turn response still contains one empty text block", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([{ type: "finish", stopReason: "end_turn", usage: USAGE }]),
    );
    const body = await readJson(response);
    expect(body.content).toEqual([{ type: "text", text: "" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  test("thinking blocks without a signature get a UUID-shaped one", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "quiet thought" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    const content = (await readJson(response)).content;
    if (!Array.isArray(content)) throw new Error("expected content array");
    const thinking = asRecord(content[0]);
    expect(thinking.type).toBe("thinking");
    expect(String(thinking.signature)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("a signature that arrives after the text block still signs the thought block", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "plan" },
        { type: "text_delta", text: "answer" },
        { type: "thinking_signature", signature: "sig-late" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    expect((await readJson(response)).content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-late" },
      { type: "text", text: "answer" },
    ]);
  });

  test("invalid_request_error events return HTTP 400, never 502", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        {
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          message: "messages must be a non-empty array",
        },
      ]),
    );
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.type).toBe("error");
    expect(asRecord(body.error).type).toBe("invalid_request_error");
    expect(asRecord(body.error).message).toBe("messages must be a non-empty array");
  });

  test("rate limits and thrown BridgeHttpErrors keep their status", async () => {
    const rateLimited = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([{ type: "error", status: 429, errorType: "rate_limit_error", message: "slow down" }]),
    );
    expect(rateLimited.status).toBe(429);

    const thrown = await collectAnthropicJsonResponse(
      MODEL,
      streamThatFailsAfter([], new BridgeHttpError(409, "invalid_request_error", "busy")),
    );
    expect(thrown.status).toBe(409);
  });

  test("a failure after partial content is still an error response, not a truncated message", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamThatFailsAfter([{ type: "text_delta", text: "half" }], new Error("pipe closed")),
    );
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.type).toBe("error");
    expect(asRecord(body.error).type).toBe("api_error");
  });

  test("auth failures mark the sign-in expired", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        {
          type: "error",
          status: 401,
          errorType: "authentication_error",
          message: "re-auth required",
          signInExpired: true,
        },
      ]),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get(SIGN_IN_HEADER)).toBe("expired");
    expect(asRecord((await readJson(response)).error).message).toBe("re-auth required");
  });

  test("thinking-only end_turn stream appends a trailing empty text block", async () => {
    const response = await collectAnthropicJsonResponse(
      MODEL,
      streamOf([
        { type: "thinking_delta", thinking: "pondering" },
        { type: "thinking_signature", signature: "sig-only" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ]),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([
      { type: "thinking", thinking: "pondering", signature: "sig-only" },
      { type: "text", text: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// encodeAnthropicSseResponse: downstream backpressure
// ---------------------------------------------------------------------------

describe("encodeAnthropicSseResponse: backpressure", () => {
  test("a reader that stops reading parks the pump instead of buffering the turn", async () => {
    let produced = 0;
    async function* chatty(): AsyncGenerator<TurnStreamEvent> {
      for (let index = 0; index < 100; index += 1) {
        produced += 1;
        yield { type: "text_delta", text: `chunk-${index};` };
      }
      yield { type: "finish", stopReason: "end_turn", usage: USAGE };
    }

    const response = await encodeAnthropicSseResponse(MODEL, chatty());
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a streaming body");

    const first = await reader.read();
    expect(first.done).toBe(false);

    // No further reads: the pump must stop pulling the upstream generator.
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(produced).toBeLessThanOrEqual(5);

    const decoder = new TextDecoder();
    let payload = decoder.decode(first.value);
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      payload += decoder.decode(next.value);
    }

    // Draining releases the turn: every delta and a clean completion arrive.
    expect(produced).toBe(100);
    const frames = parseSseFrames(payload);
    expect(frames[0]?.event).toBe("message_start");
    expect(frames[frames.length - 1]?.event).toBe("message_stop");
    const textDeltas = frames.filter(
      (frame) =>
        frame.event === "content_block_delta" && asRecord(frame.data.delta).type === "text_delta",
    );
    expect(textDeltas).toHaveLength(100);
    expect(textDeltas.map((frame) => asRecord(frame.data.delta).text)).toContain("chunk-99;");
  });

  test("cancelling a parked stream releases the upstream instead of hanging", async () => {
    const state = { finalized: false };
    async function* endless(): AsyncGenerator<TurnStreamEvent> {
      try {
        for (let index = 0; index < 200; index += 1) {
          yield { type: "text_delta", text: "x" };
        }
        yield { type: "finish", stopReason: "end_turn", usage: USAGE };
      } finally {
        state.finalized = true;
      }
    }

    const response = await encodeAnthropicSseResponse(MODEL, endless());
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a streaming body");
    await reader.read();

    // Cancelling a parked stream must complete promptly, not await a pull that
    // will never arrive.
    const outcome = await Promise.race([
      reader.cancel().then(() => "cancelled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(outcome).toBe("cancelled");

    for (let tick = 0; tick < 50 && !state.finalized; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The parked emit must be woken by teardown, not left awaiting a pull forever.
    expect(state.finalized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cloak.ts prompt cloaking
// ---------------------------------------------------------------------------

describe("cloak.ts", () => {
  test("a prompt-refusal hint carries none of the words Magpie reads as a spent window", () => {
    // The hint goes to Magpie inside a `400` body, and Magpie matches the whole
    // body: it reads no negation, so "not an account quota limit" answered
    // failQuota and rested a healthy account for its window.
    const limitWords =
      /quota|insufficient|balance|credit|billing|budget|exceeded|overload|rate[ _-]?limit|usage[ _-]?limit|too many requests|limit/i;
    const systems = [
      "x-anthropic-billing-header: cch=abc",
      "you are codex, an agent based on gpt-5",
      "you are codex, a coding agent based on gpt-5",
      "hermes agent, an intelligent ai assistant created by nous research",
      "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
      "an ordinary system prompt",
    ];
    for (const system of systems) {
      expect(refusalHint(system)).not.toMatch(limitWords);
    }
  });

  test("turnsAway flags known third-party harness trigger phrases only", () => {
    expect(turnsAway("X-Anthropic-Billing-Header: cch=abc")).toBe(true);
    expect(turnsAway("You are Codex, an agent based on GPT-5.")).toBe(true);
    expect(turnsAway("RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.")).toBe(
      true,
    );
    expect(turnsAway("You are a helpful assistant.")).toBe(false);
    expect(turnsAway(undefined)).toBe(false);
    expect(turnsAway(null)).toBe(false);
  });

  test("cloakSystemPrompt strips the billing header and rewords trigger phrases", () => {
    expect(cloakSystemPrompt("X-Anthropic-Billing-Header: cch=deadbeef\nBe terse.")).toBe(
      "Be terse.",
    );

    // The rewording is opt-in: without the flag, the line is left as the caller
    // wrote it (the refusal still classifies as one, see diagnostics).
    expect(cloakSystemPrompt("You are Codex, an agent based on GPT-5. Help me.")).toBe(
      "You are Codex, an agent based on GPT-5. Help me.",
    );

    const cloaked = cloakSystemPrompt(
      "You are Codex, an agent based on GPT-5. Help me.",
      true,
    );
    // The line is reworded, not broken up: since 11-14 Antigravity reads past
    // zero-width characters and turns the broken-up copy away all the same.
    expect(cloaked).toBe("You are Codex, an agent built on GPT-5. Help me.");
    expect(cloaked).toContain("Help me.");
    expect(turnsAway(cloaked)).toBe(false);
    // A copy someone did break up, or wrapped, is still recognized and repaired.
    expect(turnsAway("you \u200bare codex, an \u200bagent based on GPT-5")).toBe(true);
    expect(turnsAway("RFC  2119\tkeywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.")).toBe(
      true,
    );
    expect(cloakSystemPrompt("You are Codex, an \u200bagent based on GPT-5.", true)).toBe(
      "You are Codex, an agent built on GPT-5.",
    );

    // Disabled cloaking still normalizes the billing header, but leaves triggers intact.
    const raw = "You are Codex, an agent based on GPT-5.";
    expect(cloakSystemPrompt(raw, false)).toBe(raw);
    expect(turnsAway(cloakSystemPrompt(raw, false))).toBe(true);

    expect(cloakSystemPrompt(undefined)).toBe("");
  });

  test("stripVolatileSystem drops billing headers and agent clock lines", () => {
    const text =
      "X-Anthropic-Billing-Header: cch=deadbeef\nCurrent date: 2026-02-13\n# Current time: 09:31\nBe brief.";
    expect(stripVolatileSystem(text)).toBe("Be brief.");
    expect(stripVolatileSystem("  Be brief. " )).toBe("Be brief.");
    expect(stripVolatileSystem(undefined)).toBe("");
  });

  test("stripVolatileMessageText only scrubs clock lines inside system reminders", () => {
    const text =
      "<system-reminder>\nCurrent time: 12:00\nRun the tests.\n</system-reminder>\nCurrent time: 12:00";
    const stripped = stripVolatileMessageText(text);

    // Inside the reminder the timestamp is dropped so warm sessions stay warm…
    expect(stripped).toContain("Run the tests.");
    expect(stripped).toBe(
      "<system-reminder>\n\nRun the tests.\n</system-reminder>\nCurrent time: 12:00",
    );
    // …but text outside a reminder is left untouched, and billing lines go away.
    expect(stripVolatileMessageText("x-anthropic-billing-header: cch=1\nkeep me")).toBe(
      "keep me",
    );
    expect(stripVolatileMessageText(undefined)).toBe("");
  });

  test("cloakSystemPrompt rewords DeepSeek Harness @-path paragraph (#1028)", () => {
    const dsh =
      'Rule: Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.';
    const rewritten = cloakSystemPrompt(dsh, true);
    expect(rewritten).not.toContain("Tokens prefixed with @ are paths");
    expect(rewritten).toContain("When the user writes @ followed by a path");
  });

  test("parseAnthropicRequest appends structured-output reminder for output_config.format json_schema/json_object", () => {
    const parsed = parseAnthropicRequest(
      JSON.stringify({
        model: "agy-acp/gemini-3.8-flash",
        messages: [{ role: "user", content: "Evaluate safety." }],
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          },
        },
      }),
      new Headers(),
      { quotaRouting: false, cloakPrompts: true, minimalAgent: false, exposeThinking: false },
    );
    const last = parsed.messages[parsed.messages.length - 1]!;
    const texts = last.content
      .filter((p) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
    expect(texts).toContain("Structured output requirement:");
    expect(texts).toContain('"ok":{"type":"boolean"}');
  });

  test("parseAnthropicRequest percent-decodes X-Magpie-Work-Dir header", () => {
    const parsed = parseAnthropicRequest(
      JSON.stringify({
        model: "agy-acp/gemini-3.8-flash",
        messages: [{ role: "user", content: "pwd" }],
      }),
      new Headers({ "x-magpie-work-dir": "%2FUsers%2Fexample%2FMy%20Project" }),
      { quotaRouting: false, cloakPrompts: true, minimalAgent: false, exposeThinking: false },
    );
    expect(parsed.workDir).toBe("/Users/example/My Project");
  });
});
