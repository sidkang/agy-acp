import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BridgeHttpError,
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type NormalizedContentPart,
  type NormalizedMessage,
  type ProviderOptionsState,
  type ToolChoiceSpec,
  type TurnStreamEvent,
} from "../types";
import {
  stripVolatileSystem,
  stripVolatileMessageText,
} from "../protocol/cloak";
import {
  AgySessionWorker,
  SteerReplayNeededError,
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
  steerCancelTimeoutMs?: number;
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
  steerCancelTimeoutMs?: number;
}

function stableJson(val: any): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(stableJson).join(",")}]`;
  }
  const keys = Object.keys(val).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableJson(val[k])}`);
  return `{${pairs.join(",")}}`;
}

function getOpeningUserText(messages: NormalizedMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  const raw = firstUser.content
    .filter((p) => p.type === "text")
    .map((p) => (p as any).text)
    .join(" ");
  return stripVolatileMessageText(raw).trim();
}

function getToolChoiceReminder(toolChoice?: ToolChoiceSpec): string | null {
  if (!toolChoice) return null;
  if (toolChoice.type === "any") {
    return "<system-reminder>\nYou must call at least one tool in this turn.\n</system-reminder>";
  }
  if (toolChoice.type === "tool") {
    return `<system-reminder>\nYou must call the '${toolChoice.name}' tool in this turn.\n</system-reminder>`;
  }
  return null;
}

function commitAssistantTurn(
  worker: AgySessionWorker,
  req: NormalizedAnthropicRequest,
  fullAnswerText: string,
  generatedToolCalls: Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): void {
  const hasPrefill =
    req.messages.length > 0 &&
    req.messages[req.messages.length - 1]!.role === "assistant";

  if (hasPrefill) {
    const lastMsg = req.messages[req.messages.length - 1]!;
    const mergedContent: NormalizedContentPart[] = [
      ...lastMsg.content,
      ...(fullAnswerText
        ? [{ type: "text" as const, text: fullAnswerText }]
        : []),
      ...generatedToolCalls,
    ];
    worker.committedMessages = [
      ...req.messages.slice(0, -1),
      {
        role: "assistant",
        content: mergedContent,
      },
    ];
  } else {
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
  }
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
    registered.map((t) => [t.name, stableJson(t.inputSchema)]),
  );
  for (const t of incoming) {
    const existing = regMap.get(t.name);
    if (!existing || existing !== stableJson(t.inputSchema)) {
      return false;
    }
  }
  return true;
}

function hasNoOrphanToolResults(messages: NormalizedMessage[]): boolean {
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
            return false;
          }
        }
      }
    }
  }
  return true;
}

function endsWithMatchingToolPair(
  messages: NormalizedMessage[],
  pendingIds: string[],
): boolean {
  if (messages.length < 2) return false;
  const assistantMsg = messages[messages.length - 2]!;
  const userMsg = messages[messages.length - 1]!;
  if (assistantMsg.role !== "assistant" || userMsg.role !== "user") return false;

  const toolUseIds: string[] = [];
  for (const p of assistantMsg.content) {
    if (p.type === "tool_use") toolUseIds.push(p.id);
  }
  const toolResultIds: string[] = [];
  for (const p of userMsg.content) {
    if (p.type === "tool_result") toolResultIds.push(p.toolUseId);
  }

  if (toolUseIds.length === 0 || toolResultIds.length === 0) return false;

  const toolUseSet = new Set(toolUseIds);
  if (!toolResultIds.every((id) => toolUseSet.has(id))) return false;

  if (pendingIds.length > 0) {
    const pendingSet = new Set(pendingIds);
    if (!toolResultIds.some((id) => pendingSet.has(id))) return false;
  }

  return true;
}

function isCompactedRequest(
  incomingMessages: NormalizedMessage[],
  committedMessages: NormalizedMessage[],
  worker: AgySessionWorker,
): boolean {
  if (incomingMessages.length === 0) return false;
  if (!hasNoOrphanToolResults(incomingMessages)) return false;

  const pendingIds = worker.broker.getExposedPendingIds();
  const hasMatchingPair = endsWithMatchingToolPair(
    incomingMessages,
    pendingIds,
  );
  if (!hasMatchingPair) return false;

  const firstMsg = incomingMessages[0]!;
  const hasMarker = firstMsg.content.some(
    (p) =>
      p.type === "text" &&
      (/<summary[\s>]/i.test(p.text) ||
        /<\/summary>/i.test(p.text) ||
        p.text
          .toLowerCase()
          .includes(
            "conversation history before this point was compacted",
          )),
  );

  if (hasMarker) return true;

  if (incomingMessages.length < committedMessages.length) {
    return true;
  }

  return false;
}

function canonicalPartsForLedger(
  parts: NormalizedContentPart[],
): NormalizedContentPart[] {
  const filtered = parts.filter((p) => {
    if (p.type === "thinking") return false;
    return true;
  });

  const merged: NormalizedContentPart[] = [];
  for (const p of filtered) {
    if (p.type === "text") {
      const stripped = stripVolatileMessageText(p.text);
      if (merged.length > 0 && merged[merged.length - 1]!.type === "text") {
        (merged[merged.length - 1] as { type: "text"; text: string }).text +=
          stripped;
      } else {
        merged.push({ type: "text", text: stripped });
      }
    } else {
      merged.push(p);
    }
  }

  return merged.filter((p) => {
    if (p.type === "text" && p.text.trim() === "" && merged.length > 1) return false;
    return true;
  });
}

function sameToolUseIdentities(
  pParts: NormalizedContentPart[],
  fParts: NormalizedContentPart[],
): boolean {
  const pTools = pParts.filter(
    (
      p,
    ): p is {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    } => p.type === "tool_use",
  );
  const fTools = fParts.filter(
    (
      p,
    ): p is {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    } => p.type === "tool_use",
  );
  if (pTools.length !== fTools.length) return false;
  for (let i = 0; i < pTools.length; i++) {
    if (
      pTools[i]!.id !== fTools[i]!.id ||
      pTools[i]!.name !== fTools[i]!.name
    ) {
      return false;
    }
  }
  return true;
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
    const pParts = canonicalPartsForLedger(p.content);
    const fParts = canonicalPartsForLedger(f.content);
    if (stableJson(pParts) !== stableJson(fParts)) {
      if (p.role === "assistant" && sameToolUseIdentities(pParts, fParts)) {
        const pNonTool = pParts.filter((x) => x.type !== "tool_use");
        const fNonTool = fParts.filter((x) => x.type !== "tool_use");
        if (stableJson(pNonTool) === stableJson(fNonTool)) {
          continue;
        }
      }
      return false;
    }
  }
  return true;
}

function utf8Bytes(str: string): number {
  return Buffer.byteLength(str, "utf-8");
}

function utf8Prefix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= bytes) return text;
  return buf.subarray(0, bytes).toString("utf-8");
}

function utf8Suffix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= bytes) return text;
  return buf.subarray(buf.length - bytes).toString("utf-8");
}

const HISTORY_BLOCK_CLIP_BYTES = 12 * 1024;
const HISTORY_BLOCK_KEEP_BYTES = 4 * 1024;

function clipHistoryText(text: string): string {
  if (utf8Bytes(text) <= HISTORY_BLOCK_CLIP_BYTES) return text;
  const head = utf8Prefix(text, HISTORY_BLOCK_KEEP_BYTES);
  const tail = utf8Suffix(text, HISTORY_BLOCK_KEEP_BYTES);
  return `${head}\n...[truncated]...\n${tail}`;
}

const MAX_PROMPT_BYTES =
  Number(process.env.AGY_BRIDGE_MAX_PROMPT_BYTES) || 112 * 1024;
const HISTORY_RECORD_NOTE =
  "Note: <conversation_history> is a read-only record of earlier turns. Do not re-execute completed tool calls or mimic [Tool Use] text syntax; invoke real MCP tools when needed.\n";
const CONTINUATION_NOTE =
  "(system note: continue your unfinished assistant reply below from the exact character where it stops, without repeating the prefix.)";

function renderHistoryEntry(msg: NormalizedMessage): string {
  const role = msg.role === "user" ? "User" : "Assistant";
  let entryText = `[${role}]:\n`;
  for (const part of msg.content) {
    if (part.type === "text") {
      entryText += `${clipHistoryText(part.text)}\n`;
    } else if (part.type === "tool_use") {
      const inputStr = clipHistoryText(JSON.stringify(part.input, null, 2));
      entryText += `[Tool Use: ${part.name} (id: ${part.id})]:\n${inputStr}\n`;
    } else if (part.type === "tool_result") {
      const txt = part.content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text)
        .join("\n");
      entryText += `[Tool Result: id: ${part.toolUseId}]:\n${clipHistoryText(txt)}\n[end of tool result]\n`;
    }
  }
  entryText += "\n";
  return entryText;
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

  const hasPrefill =
    currentMessages.length > 0 &&
    currentMessages[currentMessages.length - 1]!.role === "assistant";

  const userMessages = hasPrefill
    ? currentMessages.slice(0, -1)
    : currentMessages;
  const prefillMessage = hasPrefill
    ? currentMessages[currentMessages.length - 1]
    : undefined;

  const isSingleWarmMessage =
    priorMessages.length === 0 && !hasPrefill && userMessages.length === 1;

  let turnText = "";
  if (isSingleWarmMessage) {
    const singleMsg = userMessages[0]!;
    for (const part of singleMsg.content) {
      if (part.type === "text") {
        turnText += `${part.text}\n`;
      } else if (part.type === "tool_result") {
        const txt = part.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");
        turnText += `[Tool Result: id: ${part.toolUseId}]:\n${txt}\n[end of tool result]\n`;
      }
    }
  } else {
    turnText = "<current_turn>\n";
    for (const msg of userMessages) {
      for (const part of msg.content) {
        if (part.type === "text") {
          turnText += `${part.text}\n`;
        } else if (part.type === "tool_result") {
          const txt = part.content
            .filter((c) => c.type === "text")
            .map((c) => (c as any).text)
            .join("\n");
          turnText += `[Tool Result: id: ${part.toolUseId}]:\n${txt}\n[end of tool result]\n`;
        }
      }
    }
    turnText += "</current_turn>\n";
  }

  let prefillText = "";
  if (prefillMessage) {
    let prefillContent = "";
    for (const part of prefillMessage.content) {
      if (part.type === "text") {
        prefillContent += part.text;
      }
    }
    prefillText = `\n<assistant_prefill>\n${prefillContent}\n${CONTINUATION_NOTE}\n</assistant_prefill>\n`;
  }

  const currentBytes = utf8Bytes(turnText + prefillText);
  let historyText = "";

  if (priorMessages.length === 0 && currentBytes > MAX_PROMPT_BYTES) {
    const truncateMarker = "\n...[truncated middle for prompt budget]...\n";
    const openMatch = /<conversation[^>]*>/i.exec(turnText);
    const closeMatch = /<\/conversation>/i.exec(turnText);

    if (openMatch && closeMatch && closeMatch.index > openMatch.index) {
      const openIdx = openMatch.index;
      const openLen = openMatch[0].length;
      const closeIdx = closeMatch.index;
      const prefix = turnText.slice(0, openIdx + openLen);
      const suffix = turnText.slice(closeIdx);
      const body = turnText.slice(openIdx + openLen, closeIdx);
      const fixedBytes =
        utf8Bytes(prefix) +
        utf8Bytes(suffix) +
        utf8Bytes(truncateMarker) +
        utf8Bytes(prefillText);
      const availableForBody = Math.max(0, MAX_PROMPT_BYTES - fixedBytes);
      const half = Math.floor(availableForBody / 2);
      const bodyHead = utf8Prefix(body, half);
      const bodyTail = utf8Suffix(body, half);
      turnText = `${prefix}${bodyHead}${truncateMarker}${bodyTail}${suffix}`;
    } else {
      const available = Math.max(
        0,
        MAX_PROMPT_BYTES - utf8Bytes(truncateMarker) - utf8Bytes(prefillText),
      );
      const half = Math.floor(available / 2);
      const head = utf8Prefix(turnText, half);
      const tail = utf8Suffix(turnText, half);
      turnText = `${head}${truncateMarker}${tail}`;
    }
  } else if (priorMessages.length > 0) {
    const historyHeader = "<conversation_history>\n";
    const historyFooter = HISTORY_RECORD_NOTE + "</conversation_history>\n\n";
    const frameBytes = utf8Bytes(historyHeader + historyFooter);
    const availableForHistory = Math.max(
      0,
      MAX_PROMPT_BYTES - currentBytes - frameBytes,
    );

    const historyEntries = priorMessages.map((m) => renderHistoryEntry(m));
    const totalHistBytes = historyEntries.reduce(
      (sum, e) => sum + utf8Bytes(e),
      0,
    );

    if (totalHistBytes <= availableForHistory) {
      historyText =
        historyHeader + historyEntries.join("") + historyFooter;
    } else {
      let omittedCount = 0;
      let startIndex = 0;
      while (startIndex < historyEntries.length) {
        const omitNote = `[... omitted ${omittedCount + 1} earlier messages ...]\n`;
        const omitBytes = utf8Bytes(omitNote);
        const remainingBytes = historyEntries
          .slice(startIndex + 1)
          .reduce((sum, e) => sum + utf8Bytes(e), 0);
        if (remainingBytes + omitBytes <= availableForHistory) {
          startIndex++;
          omittedCount++;
          historyText =
            historyHeader +
            omitNote +
            historyEntries.slice(startIndex).join("") +
            historyFooter;
          break;
        }
        startIndex++;
        omittedCount++;
      }
      if (!historyText && omittedCount > 0) {
        historyText =
          historyHeader +
          `[... omitted ${priorMessages.length} earlier messages ...]\n` +
          historyFooter;
      }
    }
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

interface ParkedSession {
  nativeSessionId: string;
  committedMessages: NormalizedMessage[];
  systemPrompt?: string;
  registeredTools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  workDir?: string;
  resumeSupported: boolean;
  parkedAt: number;
}

export class SessionCoordinator {
  readonly scheduler: GlobalScheduler;
  readonly mcpServer: LoopbackMcpServer;
  private readonly options?: SessionCoordinatorOptions;
  private readonly defaultSpawnFn?: (
    account: AccountDescriptor,
    args: string[],
    opts?: SpawnAgyOptions,
  ) => ChildProcessWithoutNullStreams;
  private readonly providerOptions?: ProviderOptionsState;

  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkers = new Map<string, AgySessionWorker>();
  private readonly parkedSessions = new Map<string, ParkedSession>();

  constructor(options: SessionCoordinatorOptions) {
    this.options = options;
    this.scheduler = options.scheduler;
    this.mcpServer = options.mcpServer;
    this.defaultSpawnFn = options.spawnFn;
    this.providerOptions = options.providerOptions;

    const prevEvict = this.scheduler.onBeforeEvictIdle;
    (this.scheduler as any).onBeforeEvictIdle = (worker: AgySessionWorker) => {
      try {
        prevEvict?.(worker);
      } catch {}
      this.parkSession(worker);
    };
  }

  private parkSession(worker: AgySessionWorker): void {
    let foundKey: string | null = null;
    for (const [key, w] of this.activeWorkers) {
      if (w === worker) {
        foundKey = key;
        break;
      }
    }
    if (!foundKey) {
      foundKey = `${worker.account.slotKey}::${worker.account.accountRef}::${worker.sessionId}`;
    }
    if (worker.nativeSessionId) {
      this.parkedSessions.set(foundKey, {
        nativeSessionId: worker.nativeSessionId,
        committedMessages: [...worker.committedMessages],
        systemPrompt: worker.systemPrompt,
        registeredTools: [...worker.registeredTools],
        workDir: worker.workDir,
        resumeSupported: worker.resumeSupported,
        parkedAt: Date.now(),
      });
      if (this.parkedSessions.size > 64) {
        const oldestKey = this.parkedSessions.keys().next().value;
        if (oldestKey) this.parkedSessions.delete(oldestKey);
      }
    }
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
      ? `${account.slotKey}::${account.accountRef}::${req.sessionId}${req.subagentId ? "::sub:" + req.subagentId : ""}`
      : null;

    let unlock: (() => void) | null = null;
    let tailPromise: Promise<void> | null = null;
    if (sessionKey) {
      if (signal?.aborted) {
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request was aborted before execution could start",
        );
      }

      let resolveLock!: () => void;
      const currentLock = new Promise<void>((r) => {
        resolveLock = r;
      });
      unlock = resolveLock;

      const prevLock = this.sessionLocks.get(sessionKey) || Promise.resolve();
      tailPromise = prevLock.then(
        () => currentLock,
        () => currentLock,
      );
      this.sessionLocks.set(sessionKey, tailPromise);

      try {
        await prevLock;
      } catch {}

      if (signal?.aborted) {
        unlock();
        if (this.sessionLocks.get(sessionKey) === tailPromise) {
          this.sessionLocks.delete(sessionKey);
        }
        throw new BridgeHttpError(
          499,
          "invalid_request_error",
          "Request was aborted while waiting for session lock",
        );
      }
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

    const baseSessionKey = `${account.slotKey}::${account.accountRef}::${req.sessionId}`;
    let existingWorker = this.activeWorkers.get(sessionKey);
    if (!existingWorker && !req.subagentId) {
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

    const baseWorker =
      this.activeWorkers.get(baseSessionKey) ??
      (existingWorker && !req.subagentId ? existingWorker : undefined);

    const isSideRequest = Boolean(
      req.tools.length === 0 &&
        baseWorker &&
        baseWorker.registeredTools.length > 0 &&
        !isPrefixMatch(baseWorker.committedMessages, req.messages),
    );

    if (isSideRequest) {
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

    // Fork detection when parent is in AWAITING_TOOL_RESULTS
    if (
      existingWorker &&
      existingWorker.state === "AWAITING_TOOL_RESULTS" &&
      !req.subagentId
    ) {
      const diffSystem =
        stripVolatileSystem(req.system) !==
        stripVolatileSystem(existingWorker.systemPrompt);
      const diffOpening =
        getOpeningUserText(req.messages) !==
        getOpeningUserText(existingWorker.committedMessages);

      if (diffSystem && diffOpening) {
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
    }

    // Case 3: Session in AWAITING_TOOL_RESULTS
    if (existingWorker && existingWorker.state === "AWAITING_TOOL_RESULTS") {
      yield* this.executeAwaitingToolsTurn(
        existingWorker,
        req,
        sessionKey,
        signal,
        modelSelection,
        options,
      );
      return;
    }

    // Case 2: Warm IDLE session with matching prefix, system prompt, and compatible tool set
    if (
      existingWorker &&
      existingWorker.state === "IDLE" &&
      stripVolatileSystem(existingWorker.systemPrompt) ===
        stripVolatileSystem(req.system) &&
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

    const parked = this.parkedSessions.get(sessionKey);
    let resumeSessionId: string | undefined = undefined;
    if (
      parked &&
      Date.now() - parked.parkedAt < 6 * 3600 * 1000 &&
      stripVolatileSystem(parked.systemPrompt) ===
        stripVolatileSystem(req.system) &&
      isToolSetCompatible(parked.registeredTools, req.tools) &&
      isPrefixMatch(parked.committedMessages, req.messages)
    ) {
      resumeSessionId = parked.nativeSessionId;
    }

    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
    const workerOptions: WorkerOptions = {
      spawnFn,
      minimalAgent:
        options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
      exposeThinking: req.thinkingEnabled,
      cloakPrompts:
        options?.providerOptions?.cloakPrompts ??
        this.providerOptions?.cloakPrompts ??
        true,
      workDir: req.workDir,
      resumeSessionId,
      systemPrompt: req.system,
      tools: req.tools,
      toolChoice: req.toolChoice,
      steerCancelTimeoutMs:
        options?.steerCancelTimeoutMs ??
        this.options?.steerCancelTimeoutMs,
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
    worker.pinned = true;

    try {
      try {
        await this.scheduler.reserveAndRegister(worker);
      } catch (err) {
        await worker.close("admission_or_start_failed");
        throw err;
      }
      this.activeWorkers.set(sessionKey, worker);

      try {
        await worker.start(signal);
      } catch (err) {
        this.activeWorkers.delete(sessionKey);
        this.scheduler.unregisterWorker(worker);
        await worker.close("admission_or_start_failed");
        throw err;
      }

      if (worker.resumedFromShelf && parked) {
        worker.committedMessages = [...parked.committedMessages];
        this.parkedSessions.delete(sessionKey);
        yield* this.executeWarmIdleTurn(
          worker,
          req,
          modelSelection,
          signal,
        );
        return;
      }

      if (requestHasImages(req.messages) && !worker.imageSupported) {
        await worker.close("image_not_supported");
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          "Images are not supported by the underlying agent",
        );
      }

      await worker.applyModelSelection(modelSelection, signal);

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
      const tcReminder = getToolChoiceReminder(req.toolChoice);
      if (tcReminder) {
        if (
          promptParts.length > 0 &&
          promptParts[promptParts.length - 1]!.type === "text"
        ) {
          (promptParts[promptParts.length - 1] as any).text += `\n\n${tcReminder}`;
        } else {
          promptParts.push({ type: "text", text: tcReminder });
        }
      }

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
          commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
        }
        yield event;
      }

      commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
    } finally {
      worker.pinned = false;
    }
  }

  private async *executeWarmIdleTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnStreamEvent> {
    worker.pinned = true;
    try {
      if (requestHasImages(req.messages) && !worker.imageSupported) {
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          "Images are not supported by the underlying agent",
        );
      }

      worker.setExposeThinking(req.thinkingEnabled);
      await worker.applyModelSelection(modelSelection, signal);
      worker.broker.setToolChoice(req.toolChoice);

      const deltaMessages = req.messages.slice(worker.committedMessages.length);
      const promptParts = renderMessagesToPrompt([], deltaMessages);
      const tcReminder = getToolChoiceReminder(req.toolChoice);
      if (tcReminder) {
        if (
          promptParts.length > 0 &&
          promptParts[promptParts.length - 1]!.type === "text"
        ) {
          (promptParts[promptParts.length - 1] as any).text += `\n\n${tcReminder}`;
        } else {
          promptParts.push({ type: "text", text: tcReminder });
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
          commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
        }
        yield event;
      }

      commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
    } finally {
      worker.pinned = false;
    }
  }

  private async *executeAwaitingToolsTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    signal?: AbortSignal,
    modelSelection?: ModelSelection,
    options?: TurnExecutionOptions,
  ): AsyncGenerator<TurnStreamEvent> {
    worker.pinned = true;
    if (options?.steerCancelTimeoutMs !== undefined) {
      worker.steerCancelTimeoutMs = options.steerCancelTimeoutMs;
    }
    try {
      // Verify prefix matches committed ledger
      const prefixLen = worker.committedMessages.length;
      if (
        req.messages.length < prefixLen ||
        !isPrefixMatch(worker.committedMessages, req.messages.slice(0, prefixLen))
      ) {
        if (isCompactedRequest(req.messages, worker.committedMessages, worker)) {
          this.activeWorkers.delete(sessionKey);
          this.scheduler.unregisterWorker(worker);
          await worker.close("compacted_during_tool_turn");
          yield* this.executeFreshSessionTurn(
            worker.account,
            req,
            modelSelection ?? { rawModelId: req.model, configModelValue: req.model },
            options,
            sessionKey,
            signal,
          );
          return;
        }

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
            content: [...part.content],
          });
        }
      }

      const TELEMETRY_NOISE_RE =
        /^\s*<system-reminder>\s*(?:Token usage:|USD budget:|<total_tokens>|Output tokens \u2014 turn:)[\s\S]*?<\/system-reminder>\s*$/i;
      const QUEUED_USER_RE =
        /The user sent (?:a new message while you were working|the following message):\s*([\s\S]*?)(?:<\/system-reminder>|$)/i;
      const COMPANION_RE =
        /^(?:<system-reminder\b|<task-notification\b|Tools? loaded\b|Base directory for this skill:|ARGUMENTS:|Skill arguments:)/i;

      for (const part of lastMsg.content) {
        if (part.type === "tool_result") continue;

        if (part.type === "image") {
          steeringParts.push(part);
          continue;
        }

        if (part.type === "text") {
          const text = part.text.trim();
          if (!text) continue;

          if (TELEMETRY_NOISE_RE.test(part.text)) {
            continue;
          }

          const queuedMatch = QUEUED_USER_RE.exec(part.text);
          if (queuedMatch) {
            const inner = queuedMatch[1]!
              .replace(
                /\n\n(?:This is how Claude Code surfaces[\s\S]*|IMPORTANT:[\s\S]*|Please address this message[\s\S]*)$/i,
                "",
              )
              .trim();
            steeringParts.push({ type: "text", text: inner });
            continue;
          }

          if (
            COMPANION_RE.test(text) ||
            /^\[MESSAGE FROM NON-USER SOURCE/i.test(text) ||
            /hook (?:additional context|success|blocking error|feedback)/i.test(
              text,
            )
          ) {
            if (toolResults.length > 0) {
              toolResults[toolResults.length - 1]!.content.push({
                type: "text",
                text: part.text,
              });
            }
            continue;
          }

          steeringParts.push(part);
        }
      }

      const toolsChanged = !isToolSetCompatible(worker.registeredTools, req.tools);
      if (toolsChanged) {
        const regNames = new Set(worker.registeredTools.map((t) => t.name));
        const hasNewTools = req.tools.some((t) => !regNames.has(t.name));
        worker.broker.setTools(req.tools);
        worker.registeredTools = [...req.tools];
        steeringParts.push({
          type: "text",
          text: hasNewTools
            ? "Continue with the newly loaded tools."
            : "Continue with the updated tools.",
        });
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

      let yieldedAny = false;
      try {
        for await (const event of worker.continueWithToolResults(
          toolResults,
          steeringParts,
          signal,
          modelSelection,
        )) {
          yieldedAny = true;
          if (event.type === "tool_use") {
            generatedToolCalls.push(event);
          } else if (event.type === "text_delta") {
            fullAnswerText += event.text;
          } else if (event.type === "finish") {
            commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
          }
          yield event;
        }
      } catch (err) {
        if (err instanceof SteerReplayNeededError && !yieldedAny) {
          this.activeWorkers.delete(sessionKey);
          this.scheduler.unregisterWorker(worker);
          await worker.close("steer_replay_needed");
          yield* this.executeFreshSessionTurn(
            worker.account,
            req,
            modelSelection ?? { rawModelId: req.model, configModelValue: req.model },
            options,
            sessionKey,
            signal,
          );
          return;
        }
        throw err;
      }

      commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
    } finally {
      worker.pinned = false;
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
    worker.pinned = true;

    try {
      try {
        await this.scheduler.reserveAndRegister(worker);
      } catch (err) {
        await worker.close("admission_or_start_failed");
        throw err;
      }

      try {
        await worker.start(signal);
      } catch (err) {
        this.scheduler.unregisterWorker(worker);
        await worker.close("admission_or_start_failed");
        throw err;
      }

      if (requestHasImages(req.messages) && !worker.imageSupported) {
        throw new BridgeHttpError(
          400,
          "invalid_request_error",
          "Images are not supported by the underlying agent",
        );
      }

      await worker.applyModelSelection(modelSelection, signal);

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
      worker.pinned = false;
      this.scheduler.unregisterWorker(worker);
      await worker.close("stateless_turn_finished");
    }
  }
}
