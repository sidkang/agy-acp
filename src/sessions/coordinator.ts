import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type NormalizedContentPart,
  type NormalizedMessage,
  type ProviderOptionsState,
  type TurnStreamEvent,
} from "../types";
import {
  AgySessionWorker,
  type ModelSelection,
  type WorkerOptions,
} from "../runtime/worker";
import type { GlobalScheduler } from "../runtime/scheduler";
import type { LoopbackMcpServer } from "../mcp/http-server";
import type { SpawnAgyOptions } from "../accounts/env";
import type { ToolResultDelivery } from "../mcp/broker";

export interface TurnExecutionOptions {
  spawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  providerOptions?: ProviderOptionsState;
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
}

function validateNoOrphanToolResults(messages: NormalizedMessage[]): void {
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool_use") {
          toolUseIds.add(part.id);
        }
      }
    } else if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type === "tool_result") {
          if (!toolUseIds.has(part.toolUseId)) {
            throw new BridgeHttpError(
              400,
              "invalid_request_error",
              `Orphan tool_result with tool_use_id '${part.toolUseId}' has no matching prior tool_use`,
            );
          }
        }
      }
    }
  }
}

function requestHasImages(messages: NormalizedMessage[]): boolean {
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === "image") return true;
      if (part.type === "tool_result") {
        for (const item of part.content) {
          if (item.type === "image") return true;
        }
      }
    }
  }
  return false;
}

function isToolSetCompatible(
  registered: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
  incoming: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
): boolean {
  if (registered.length !== incoming.length) return false;
  const regMap = new Map(
    registered.map((t) => [t.name, JSON.stringify(t.inputSchema)]),
  );
  for (const t of incoming) {
    const existing = regMap.get(t.name);
    if (!existing || existing !== JSON.stringify(t.inputSchema)) {
      return false;
    }
  }
  return true;
}

function canonicalPartsForLedger(parts: NormalizedContentPart[]): NormalizedContentPart[] {
  return parts.filter((p) => {
    if (p.type === "thinking") return false;
    if (p.type === "text" && p.text === "" && parts.length > 1) return false;
    return true;
  });
}

function isPrefixMatch(
  prefix: NormalizedMessage[],
  full: NormalizedMessage[],
): boolean {
  if (full.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const p = prefix[i]!;
    const f = full[i]!;
    if (p.role !== f.role) return false;
    if (
      JSON.stringify(canonicalPartsForLedger(p.content)) !==
      JSON.stringify(canonicalPartsForLedger(f.content))
    ) {
      return false;
    }
  }
  return true;
}

function renderMessagesToPrompt(
  priorMessages: NormalizedMessage[],
  currentMessages: NormalizedMessage[],
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];

  let historyText = "";
  if (priorMessages.length > 0) {
    historyText += "<conversation_history>\n";
    for (const msg of priorMessages) {
      const role = msg.role === "user" ? "User" : "Assistant";
      historyText += `[${role}]:\n`;
      for (const part of msg.content) {
        if (part.type === "text") {
          historyText += `${part.text}\n`;
        } else if (part.type === "tool_use") {
          historyText += `[Tool Use: ${part.name} (id: ${part.id})]:\n${JSON.stringify(part.input, null, 2)}\n`;
        } else if (part.type === "tool_result") {
          const txt = part.content
            .filter((c) => c.type === "text")
            .map((c) => (c as any).text)
            .join("\n");
          historyText += `[Tool Result: id: ${part.toolUseId}]:\n${txt}\n`;
        }
      }
      historyText += "\n";
    }
    historyText += "</conversation_history>\n\n";
  }

  const hasPrefill =
    currentMessages.length > 0 &&
    currentMessages[currentMessages.length - 1]!.role === "assistant";

  const userMessages = hasPrefill
    ? currentMessages.slice(0, -1)
    : currentMessages;
  const prefillMessage = hasPrefill
    ? currentMessages[currentMessages.length - 1]
    : undefined;

  let turnText = "<current_turn>\n";
  for (const msg of userMessages) {
    for (const part of msg.content) {
      if (part.type === "text") {
        turnText += `${part.text}\n`;
      } else if (part.type === "tool_result") {
        const txt = part.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");
        turnText += `[Tool Result: id: ${part.toolUseId}]:\n${txt}\n`;
      }
    }
  }
  turnText += "</current_turn>\n";

  let prefillText = "";
  if (prefillMessage) {
    prefillText = "\n<assistant_prefill>\n";
    for (const part of prefillMessage.content) {
      if (part.type === "text") {
        prefillText += `${part.text}\n`;
      }
    }
    prefillText += "</assistant_prefill>\n";
  }

  const combinedText = `${historyText}${turnText}${prefillText}`.trim();
  if (combinedText) {
    parts.push({ type: "text", text: combinedText });
  }

  const allMessages = [...priorMessages, ...userMessages];
  for (const msg of allMessages) {
    for (const part of msg.content) {
      if (part.type === "image") {
        parts.push({
          type: "image",
          data: part.data,
          mimeType: part.mediaType,
        });
      } else if (part.type === "tool_result") {
        for (const item of part.content) {
          if (item.type === "image") {
            parts.push({
              type: "image",
              data: item.data,
              mimeType: item.mediaType,
            });
          }
        }
      }
    }
  }

  return parts;
}

export class SessionCoordinator {
  readonly scheduler: GlobalScheduler;
  readonly mcpServer: LoopbackMcpServer;
  private readonly defaultSpawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  private readonly providerOptions?: ProviderOptionsState;

  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkers = new Map<string, AgySessionWorker>();

  constructor(options: SessionCoordinatorOptions) {
    this.scheduler = options.scheduler;
    this.mcpServer = options.mcpServer;
    this.defaultSpawnFn = options.spawnFn;
    this.providerOptions = options.providerOptions;
  }

  getActiveWorker(sessionKey: string): AgySessionWorker | undefined {
    const direct = this.activeWorkers.get(sessionKey);
    if (direct) return direct;
    for (const [key, worker] of this.activeWorkers) {
      const parts = key.split("::");
      if (parts.length === 3 && `${parts[0]}::${parts[2]}` === sessionKey) {
        return worker;
      }
    }
    return undefined;
  }

  async *executeTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options?: TurnExecutionOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    const sessionKey = req.sessionId
      ? `${account.slotKey}::${account.accountRef}::${req.sessionId}`
      : null;

    let unlock: (() => void) | null = null;
    let tailPromise: Promise<void> | null = null;
    if (sessionKey) {
      let resolveLock!: () => void;
      const currentLock = new Promise<void>((r) => {
        resolveLock = r;
      });
      unlock = resolveLock;

      const prevLock = this.sessionLocks.get(sessionKey) || Promise.resolve();
      tailPromise = prevLock.then(() => currentLock);
      this.sessionLocks.set(sessionKey, tailPromise);
      await prevLock;
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

    let existingWorker = this.activeWorkers.get(sessionKey);
    if (!existingWorker && req.sessionId) {
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

    if (
      existingWorker &&
      existingWorker.account.accountRef !== account.accountRef
    ) {
      for (const [k, w] of this.activeWorkers) {
        if (w === existingWorker) {
          this.activeWorkers.delete(k);
        }
      }
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("account_mismatch");
      existingWorker = undefined;
    }

    // Case 3: Session in AWAITING_TOOL_RESULTS
    if (existingWorker && existingWorker.state === "AWAITING_TOOL_RESULTS") {
      yield* this.executeAwaitingToolsTurn(
        existingWorker,
        req,
        sessionKey,
        signal,
      );
      return;
    }

    // Case 2: Warm IDLE session with matching prefix, system prompt, and compatible tool set
    if (
      existingWorker &&
      existingWorker.state === "IDLE" &&
      existingWorker.systemPrompt === (req.system || undefined) &&
      isToolSetCompatible(existingWorker.registeredTools, req.tools) &&
      isPrefixMatch(existingWorker.committedMessages, req.messages)
    ) {
      yield* this.executeWarmIdleTurn(
        existingWorker,
        req,
        modelSelection,
        signal,
      );
      return;
    }

    // Case 4: Warm IDLE session where history diverged/compacted or tools changed
    if (existingWorker && existingWorker.state === "IDLE") {
      this.activeWorkers.delete(sessionKey);
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

  private async *executeFreshSessionTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options: TurnExecutionOptions | undefined,
    sessionKey: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    validateNoOrphanToolResults(req.messages);

    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
    const workerOptions: WorkerOptions = {
      spawnFn,
      minimalAgent:
        options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
      exposeThinking: req.thinkingEnabled,
      systemPrompt: req.system,
      tools: req.tools,
      toolChoice: req.toolChoice,
      onStateChange: (_worker, _oldState, newState) => {
        if (newState === "CLOSED") {
          this.activeWorkers.delete(sessionKey);
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

    await this.scheduler.reserveAndRegister(worker);
    this.activeWorkers.set(sessionKey, worker);

    try {
      await worker.start();
    } catch (err) {
      this.activeWorkers.delete(sessionKey);
      this.scheduler.unregisterWorker(worker);
      await worker.close("start_failed");
      throw err;
    }

    if (requestHasImages(req.messages) && !worker.imageSupported) {
      await worker.close("image_not_supported");
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        "Images are not supported by the underlying agent",
      );
    }

    await worker.applyModelSelection(modelSelection);

    // Determine prior messages vs current turn
    let priorMessages: NormalizedMessage[] = [];
    let currentMessages: NormalizedMessage[] = [];

    const hasPrefill =
      req.messages.length > 0 &&
      req.messages[req.messages.length - 1]!.role === "assistant";

    if (hasPrefill) {
      priorMessages = req.messages.slice(0, -2);
      currentMessages = req.messages.slice(-2);
    } else {
      priorMessages = req.messages.slice(0, -1);
      currentMessages = req.messages.slice(-1);
    }

    const promptParts = renderMessagesToPrompt(priorMessages, currentMessages);
    if (req.system && !worker.appendSystemSupported) {
      const sysPrompt = `<system_instructions>\n${req.system}\n</system_instructions>\n\n`;
      if (promptParts.length > 0 && promptParts[0]!.type === "text") {
        promptParts[0] = {
          type: "text",
          text: `${sysPrompt}${promptParts[0]!.text}`,
        };
      } else {
        promptParts.unshift({ type: "text", text: sysPrompt });
      }
    }

    const generatedToolCalls: Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let fullAnswerText = "";

    for await (const event of worker.startPromptTurn(promptParts, signal)) {
      if (event.type === "tool_use") {
        generatedToolCalls.push(event);
      } else if (event.type === "text_delta") {
        fullAnswerText += event.text;
      } else if (event.type === "finish") {
        if (event.stopReason === "tool_use") {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [
                ...(fullAnswerText
                  ? [{ type: "text" as const, text: fullAnswerText }]
                  : []),
                ...generatedToolCalls,
              ],
            },
          ];
        } else {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [{ type: "text" as const, text: fullAnswerText }],
            },
          ];
        }
      }
      yield event;
    }

    if (worker.state === "AWAITING_TOOL_RESULTS") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [
            ...(fullAnswerText
              ? [{ type: "text" as const, text: fullAnswerText }]
              : []),
            ...generatedToolCalls,
          ],
        },
      ];
    } else if (worker.state === "IDLE") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: fullAnswerText }],
        },
      ];
    }
  }

  private async *executeWarmIdleTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    if (requestHasImages(req.messages) && !worker.imageSupported) {
      throw new BridgeHttpError(
        400,
        "invalid_request_error",
        "Images are not supported by the underlying agent",
      );
    }

    worker.setExposeThinking(req.thinkingEnabled);
    await worker.applyModelSelection(modelSelection);
    worker.broker.setToolChoice(req.toolChoice);

    const deltaMessages = req.messages.slice(worker.committedMessages.length);
    const promptParts = renderMessagesToPrompt([], deltaMessages);

    const generatedToolCalls: Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let fullAnswerText = "";

    for await (const event of worker.startPromptTurn(promptParts, signal)) {
      if (event.type === "tool_use") {
        generatedToolCalls.push(event);
      } else if (event.type === "text_delta") {
        fullAnswerText += event.text;
      } else if (event.type === "finish") {
        if (event.stopReason === "tool_use") {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [
                ...(fullAnswerText
                  ? [{ type: "text" as const, text: fullAnswerText }]
                  : []),
                ...generatedToolCalls,
              ],
            },
          ];
        } else {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [{ type: "text" as const, text: fullAnswerText }],
            },
          ];
        }
      }
      yield event;
    }

    if (worker.state === "AWAITING_TOOL_RESULTS") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [
            ...(fullAnswerText
              ? [{ type: "text" as const, text: fullAnswerText }]
              : []),
            ...generatedToolCalls,
          ],
        },
      ];
    } else if (worker.state === "IDLE") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: fullAnswerText }],
        },
      ];
    }
  }

  private async *executeAwaitingToolsTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    // Verify prefix matches committed ledger
    const prefixLen = worker.committedMessages.length;
    if (
      req.messages.length < prefixLen ||
      !isPrefixMatch(worker.committedMessages, req.messages.slice(0, prefixLen))
    ) {
      // Branching while tool calls are pending!
      throw new BridgeHttpError(
        409,
        "invalid_request_error",
        "Cannot branch session while tool calls are pending",
      );
    }

    // Delta messages after committed ledger
    const deltaMessages = req.messages.slice(prefixLen);
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
          content: part.content,
        });
      } else {
        steeringParts.push(part);
      }
    }

    worker.setExposeThinking(req.thinkingEnabled);
    worker.broker.setToolChoice(req.toolChoice);

    const generatedToolCalls: Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let fullAnswerText = "";

    for await (const event of worker.continueWithToolResults(
      toolResults,
      steeringParts,
      signal,
    )) {
      if (event.type === "tool_use") {
        generatedToolCalls.push(event);
      } else if (event.type === "text_delta") {
        fullAnswerText += event.text;
      } else if (event.type === "finish") {
        if (event.stopReason === "tool_use") {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [
                ...(fullAnswerText
                  ? [{ type: "text" as const, text: fullAnswerText }]
                  : []),
                ...generatedToolCalls,
              ],
            },
          ];
        } else {
          worker.committedMessages = [
            ...req.messages,
            {
              role: "assistant",
              content: [{ type: "text" as const, text: fullAnswerText }],
            },
          ];
        }
      }
      yield event;
    }

    if (worker.state === "AWAITING_TOOL_RESULTS") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [
            ...(fullAnswerText
              ? [{ type: "text" as const, text: fullAnswerText }]
              : []),
            ...generatedToolCalls,
          ],
        },
      ];
    } else if (worker.state === "IDLE") {
      worker.committedMessages = [
        ...req.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: fullAnswerText }],
        },
      ];
    }
  }

  private async *executeStatelessTurn(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    options: TurnExecutionOptions | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    await this.scheduler.ensureCapacity(account);

    const ephemeralSessionId = `ephemeral-${crypto.randomUUID()}`;
    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
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
        systemPrompt: req.system,
        tools: req.tools,
        toolChoice: req.toolChoice,
      },
    );

    await this.scheduler.reserveAndRegister(worker);

    try {
      await worker.start();
    } catch (err) {
      this.scheduler.unregisterWorker(worker);
      await worker.close("start_failed");
      throw err;
    }

    try {
      if (requestHasImages(req.messages) && !worker.imageSupported) {
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          "Images are not supported by the underlying agent",
        );
      }

      await worker.applyModelSelection(modelSelection);

      let priorMessages: NormalizedMessage[] = [];
      let currentMessages: NormalizedMessage[] = [];

      const hasPrefill =
        req.messages.length > 0 &&
        req.messages[req.messages.length - 1]!.role === "assistant";

      if (hasPrefill) {
        priorMessages = req.messages.slice(0, -2);
        currentMessages = req.messages.slice(-2);
      } else {
        priorMessages = req.messages.slice(0, -1);
        currentMessages = req.messages.slice(-1);
      }

      const promptParts = renderMessagesToPrompt(
        priorMessages,
        currentMessages,
      );
      if (req.system && !worker.appendSystemSupported) {
        const sysPrompt = `<system_instructions>\n${req.system}\n</system_instructions>\n\n`;
        if (promptParts.length > 0 && promptParts[0]!.type === "text") {
          promptParts[0] = {
            type: "text",
            text: `${sysPrompt}${promptParts[0]!.text}`,
          };
        } else {
          promptParts.unshift({ type: "text", text: sysPrompt });
        }
      }
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        yield event;
      }
    } finally {
      this.scheduler.unregisterWorker(worker);
      await worker.close("stateless_turn_finished");
    }
  }
}
