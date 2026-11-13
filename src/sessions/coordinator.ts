import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
import {
  getPluginDataRoot,
  sweepStaleAccountStorage,
  type SpawnAgyOptions,
} from "../accounts/env";
import { resolveConversationDbPath } from "../usage/step-usage";
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
const SEED_BLOCK_CLIP_BYTES = 64 * 1024;
const SEED_BLOCK_KEEP_BYTES = 24 * 1024;

function clipHistoryText(
  text: string,
  clipBytes = HISTORY_BLOCK_CLIP_BYTES,
  keepBytes = HISTORY_BLOCK_KEEP_BYTES,
): string {
  if (utf8Bytes(text) <= clipBytes) return text;
  const head = utf8Prefix(text, keepBytes);
  const tail = utf8Suffix(text, keepBytes);
  return `${head}\n...[truncated]...\n${tail}`;
}

const MAX_PROMPT_BYTES =
  Number(process.env.AGY_BRIDGE_MAX_PROMPT_BYTES) || 112 * 1024;
const HISTORY_RECORD_NOTE =
  "Note: <conversation_history> is a read-only record of earlier turns. Do not re-execute completed tool calls or mimic [Tool Use] text syntax; invoke real MCP tools when needed.\n";
const PRIOR_HISTORY_RECORD_NOTE =
  "Note: <prior_conversation_history> is a read-only record of earlier turns in this conversation. Do not re-execute completed tool calls or mimic [Tool Use] text syntax; invoke real MCP tools when needed.\n";
const SEEDED_ABOVE_NOTE =
  "[Earlier turns are preserved in <prior_conversation_history> above.]\n";
const CONTINUATION_NOTE =
  "(system note: continue your unfinished assistant reply below from the exact character where it stops, without repeating the prefix.)";

function renderHistoryEntry(
  msg: NormalizedMessage,
  clipBytes = HISTORY_BLOCK_CLIP_BYTES,
  keepBytes = HISTORY_BLOCK_KEEP_BYTES,
): string {
  const role = msg.role === "user" ? "User" : "Assistant";
  let entryText = `[${role}]:\n`;
  for (const part of msg.content) {
    if (part.type === "text") {
      entryText += `${clipHistoryText(part.text, clipBytes, keepBytes)}\n`;
    } else if (part.type === "tool_use") {
      const inputStr = clipHistoryText(
        JSON.stringify(part.input, null, 2),
        clipBytes,
        keepBytes,
      );
      entryText += `[Tool Use: ${part.name} (id: ${part.id})]:\n${inputStr}\n`;
    } else if (part.type === "tool_result") {
      const txt = part.content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text)
        .join("\n");
      entryText += `[Tool Result: id: ${part.toolUseId}]:\n${clipHistoryText(txt, clipBytes, keepBytes)}\n[end of tool result]\n`;
    }
  }
  entryText += "\n";
  return entryText;
}

function splitPriorAndCurrent(messages: NormalizedMessage[]): {
  priorMessages: NormalizedMessage[];
  currentMessages: NormalizedMessage[];
} {
  const hasPrefill =
    messages.length > 0 && messages[messages.length - 1]!.role === "assistant";
  if (hasPrefill) {
    return {
      priorMessages: messages.slice(0, -2),
      currentMessages: messages.slice(-2),
    };
  }
  return {
    priorMessages: messages.slice(0, -1),
    currentMessages: messages.slice(-1),
  };
}

function renderCurrentTurnParts(
  currentMessages: NormalizedMessage[],
  isSingleWarmMessage: boolean,
): {
  userMessages: NormalizedMessage[];
  turnText: string;
  prefillText: string;
} {
  const hasPrefill =
    currentMessages.length > 0 &&
    currentMessages[currentMessages.length - 1]!.role === "assistant";
  const userMessages = hasPrefill
    ? currentMessages.slice(0, -1)
    : currentMessages;
  const prefillMessage = hasPrefill
    ? currentMessages[currentMessages.length - 1]
    : undefined;

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

  return { userMessages, turnText, prefillText };
}

function planColdHistoryRender(
  priorMessages: NormalizedMessage[],
  currentMessages: NormalizedMessage[],
  modelId: string,
): {
  systemHistorySeed?: string;
  tailPriorMessages: NormalizedMessage[];
} {
  if (priorMessages.length === 0) {
    return { systemHistorySeed: undefined, tailPriorMessages: [] };
  }

  const { turnText, prefillText } = renderCurrentTurnParts(
    currentMessages,
    false,
  );
  const currentBytes = utf8Bytes(turnText + prefillText);
  const historyHeader = "<conversation_history>\n";
  const historyFooter = HISTORY_RECORD_NOTE + "</conversation_history>\n\n";
  const frameBytes = utf8Bytes(historyHeader + historyFooter);
  const availableForPromptHistory = Math.max(
    0,
    MAX_PROMPT_BYTES - currentBytes - frameBytes,
  );

  const promptEntries = priorMessages.map((m) => renderHistoryEntry(m));
  const promptEntryBytes = promptEntries.map((e) => utf8Bytes(e));
  const totalPromptHistBytes = promptEntryBytes.reduce((a, b) => a + b, 0);

  if (totalPromptHistBytes <= availableForPromptHistory) {
    return { systemHistorySeed: undefined, tailPriorMessages: priorMessages };
  }

  const seededNoteBytes = utf8Bytes(SEEDED_ABOVE_NOTE);
  let suffixBytes = 0;
  let splitIdx = priorMessages.length;
  for (let i = priorMessages.length - 1; i >= 1; i--) {
    const nextBytes = suffixBytes + promptEntryBytes[i]!;
    if (nextBytes + seededNoteBytes <= availableForPromptHistory) {
      suffixBytes = nextBytes;
      splitIdx = i;
    } else {
      break;
    }
  }

  const overflowMessages = priorMessages.slice(0, splitIdx);
  const tailPriorMessages = priorMessages.slice(splitIdx);

  const seedHeader = "<prior_conversation_history>\n";
  const seedFooter =
    PRIOR_HISTORY_RECORD_NOTE + "</prior_conversation_history>";
  const maxSeedBytes = /gpt-oss/i.test(modelId)
    ? 256 * 1024
    : Number(process.env.AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES) ||
      2 * 1024 * 1024;
  const availableForSeed = Math.max(
    0,
    maxSeedBytes - utf8Bytes(seedHeader + seedFooter),
  );

  const seedEntries = overflowMessages.map((m) =>
    renderHistoryEntry(m, SEED_BLOCK_CLIP_BYTES, SEED_BLOCK_KEEP_BYTES),
  );
  const seedEntryBytes = seedEntries.map((e) => utf8Bytes(e));
  const totalSeedBytes = seedEntryBytes.reduce((a, b) => a + b, 0);

  let seedBody = "";
  if (totalSeedBytes <= availableForSeed) {
    seedBody = seedEntries.join("");
  } else {
    let remainingBytes = totalSeedBytes;
    let startIndex = 0;
    while (startIndex < seedEntries.length) {
      remainingBytes -= seedEntryBytes[startIndex]!;
      startIndex++;
      const omitNote = `[... omitted ${startIndex} earlier messages ...]\n`;
      if (remainingBytes + utf8Bytes(omitNote) <= availableForSeed) {
        seedBody = omitNote + seedEntries.slice(startIndex).join("");
        break;
      }
    }
    if (!seedBody) {
      seedBody = `[... omitted ${overflowMessages.length} earlier messages ...]\n`;
    }
  }

  return {
    systemHistorySeed: `${seedHeader}${seedBody}${seedFooter}`,
    tailPriorMessages,
  };
}

interface RenderPromptOptions {
  priorSeededInSystem?: boolean;
  imageSourceMessages?: NormalizedMessage[];
}

function renderMessagesToPrompt(
  priorMessages: NormalizedMessage[],
  currentMessages: NormalizedMessage[],
  opts?: RenderPromptOptions,
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
  const userMessagesCount = hasPrefill
    ? currentMessages.length - 1
    : currentMessages.length;
  const isSingleWarmMessage =
    priorMessages.length === 0 &&
    !opts?.priorSeededInSystem &&
    !hasPrefill &&
    userMessagesCount === 1;

  let { userMessages, turnText, prefillText } = renderCurrentTurnParts(
    currentMessages,
    isSingleWarmMessage,
  );

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
  } else if (priorMessages.length > 0 || opts?.priorSeededInSystem) {
    const historyHeader = "<conversation_history>\n";
    const historyFooter = HISTORY_RECORD_NOTE + "</conversation_history>\n\n";
    const frameBytes = utf8Bytes(historyHeader + historyFooter);
    const availableForHistory = Math.max(
      0,
      MAX_PROMPT_BYTES - currentBytes - frameBytes,
    );

    const leadNote = opts?.priorSeededInSystem ? SEEDED_ABOVE_NOTE : "";
    const leadBytes = utf8Bytes(leadNote);
    const historyEntries = priorMessages.map((m) => renderHistoryEntry(m));
    const totalHistBytes =
      leadBytes +
      historyEntries.reduce((sum, e) => sum + utf8Bytes(e), 0);

    if (totalHistBytes <= availableForHistory) {
      historyText =
        historyHeader + leadNote + historyEntries.join("") + historyFooter;
    } else if (historyEntries.length > 0) {
      let omittedCount = 0;
      let startIndex = 0;
      while (startIndex < historyEntries.length) {
        const omitNote = `[... omitted ${omittedCount + 1} earlier messages ...]\n`;
        const omitBytes = utf8Bytes(omitNote);
        const remainingBytes = historyEntries
          .slice(startIndex + 1)
          .reduce((sum, e) => sum + utf8Bytes(e), 0);
        if (leadBytes + remainingBytes + omitBytes <= availableForHistory) {
          startIndex++;
          omittedCount++;
          historyText =
            historyHeader +
            leadNote +
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
          leadNote +
          `[... omitted ${priorMessages.length} earlier messages ...]\n` +
          historyFooter;
      }
    }
  }

  const combinedText = `${historyText}${turnText}${prefillText}`.trim();
  if (combinedText) {
    parts.push({ type: "text", text: combinedText });
  }

  const allMessages = [
    ...(opts?.imageSourceMessages ?? priorMessages),
    ...userMessages,
  ];
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

const PARKED_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_PARKED_SESSIONS = 32;
const MAX_SINGLE_PARKED_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_TOTAL_PARKED_BYTES = 16 * 1024 * 1024; // 16 MiB

interface ParkedSession {
  nativeSessionId: string;
  committedMessages: NormalizedMessage[];
  systemPrompt?: string;
  systemHistorySeed?: string;
  minimalAgent: boolean;
  registeredTools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  workDir?: string;
  resumeSupported: boolean;
  parkedAt: number;
  estimatedBytes: number;
}

function estimateParkedBytes(
  messages: NormalizedMessage[],
  systemPrompt: string | undefined,
  systemHistorySeed: string | undefined,
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): number {
  let bytes =
    (systemPrompt ? utf8Bytes(systemPrompt) : 0) +
    (systemHistorySeed ? utf8Bytes(systemHistorySeed) : 0);
  try {
    bytes += utf8Bytes(JSON.stringify(tools));
    bytes += utf8Bytes(JSON.stringify(messages));
  } catch {
    bytes += 64 * 1024;
  }
  return bytes;
}

/**
 * Zero-plaintext, digest-only description of a resumable session. Persisted to
 * `parked-sessions.json` inside the plugin data root so a restarted plugin host
 * can issue `session/resume` without ever writing message text, tool arguments,
 * tool outputs, system prompt text, or the system history seed to disk.
 */
interface PersistedParkedMessageDigest {
  role: "user" | "assistant";
  fullDigest: string;
  toolIdentities?: Array<{ id: string; name: string }>;
  nonToolDigest?: string;
}

interface PersistedParkedSession {
  nativeSessionId: string;
  accountRef: string;
  minimalAgent: boolean;
  workDir?: string;
  parkedAt: number;
  systemPromptDigest: string;
  toolsDigests: Array<{ name: string; schemaDigest: string }>;
  messageDigests: PersistedParkedMessageDigest[];
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function digestToolsForPersistence(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
): Array<{ name: string; schemaDigest: string }> {
  return tools.map((t) => ({
    name: t.name,
    schemaDigest: sha256Hex(stableJson(t.inputSchema)),
  }));
}

function toolsMatchPersistedDigests(
  digests: Array<{ name: string; schemaDigest: string }>,
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
): boolean {
  if (digests.length !== tools.length) return false;
  const byName = new Map(digests.map((d) => [d.name, d.schemaDigest]));
  for (const t of tools) {
    const existing = byName.get(t.name);
    if (!existing || existing !== sha256Hex(stableJson(t.inputSchema))) {
      return false;
    }
  }
  return true;
}

function digestMessagesForPersistence(
  messages: NormalizedMessage[],
): PersistedParkedMessageDigest[] {
  return messages.map((msg) => {
    const pParts = canonicalPartsForLedger(msg.content);
    const fullDigest = sha256Hex(stableJson(pParts));
    if (msg.role !== "assistant") {
      return { role: "user" as const, fullDigest };
    }
    const toolIdentities = pParts
      .filter(
        (
          p,
        ): p is {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        } => p.type === "tool_use",
      )
      .map((p) => ({ id: p.id, name: p.name }));
    const nonToolDigest = sha256Hex(
      stableJson(pParts.filter((p) => p.type !== "tool_use")),
    );
    return {
      role: "assistant" as const,
      fullDigest,
      toolIdentities,
      nonToolDigest,
    };
  });
}

/**
 * Mirrors `isPrefixMatch` exactly, but against the on-disk digest index:
 * tolerates reordered `tool_use` JSON keys / client-added default fields by
 * comparing tool identities + a digest of the remaining parts.
 */
function persistedPrefixMatches(
  digests: PersistedParkedMessageDigest[],
  messages: NormalizedMessage[],
): boolean {
  if (digests.length === 0) return false;
  if (messages.length < digests.length) return false;
  for (let i = 0; i < digests.length; i++) {
    const digest = digests[i]!;
    const msg = messages[i]!;
    if (msg.role !== digest.role) return false;
    const pParts = canonicalPartsForLedger(msg.content);
    if (sha256Hex(stableJson(pParts)) === digest.fullDigest) continue;
    if (msg.role === "assistant" && digest.nonToolDigest !== undefined) {
      const toolIdentities = pParts
        .filter(
          (
            p,
          ): p is {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          } => p.type === "tool_use",
        )
        .map((p) => ({ id: p.id, name: p.name }));
      if (
        stableJson(toolIdentities) ===
          stableJson(digest.toolIdentities ?? []) &&
        sha256Hex(stableJson(pParts.filter((p) => p.type !== "tool_use"))) ===
          digest.nonToolDigest
      ) {
        continue;
      }
    }
    return false;
  }
  return true;
}

function normalizePersistedEntry(raw: unknown): PersistedParkedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, any>;
  if (typeof e.nativeSessionId !== "string" || !e.nativeSessionId) return null;
  if (typeof e.accountRef !== "string" || !e.accountRef) return null;
  if (typeof e.minimalAgent !== "boolean") return null;
  if (typeof e.parkedAt !== "number" || !Number.isFinite(e.parkedAt)) {
    return null;
  }
  if (typeof e.systemPromptDigest !== "string") return null;
  if (!Array.isArray(e.toolsDigests) || !Array.isArray(e.messageDigests)) {
    return null;
  }
  const toolsDigests: Array<{ name: string; schemaDigest: string }> = [];
  for (const t of e.toolsDigests) {
    if (!t || typeof t.name !== "string" || typeof t.schemaDigest !== "string") {
      return null;
    }
    toolsDigests.push({ name: t.name, schemaDigest: t.schemaDigest });
  }
  const messageDigests: PersistedParkedMessageDigest[] = [];
  for (const m of e.messageDigests) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.fullDigest !== "string") return null;
    const digest: PersistedParkedMessageDigest = {
      role: m.role,
      fullDigest: m.fullDigest,
    };
    if (m.role === "assistant") {
      if (Array.isArray(m.toolIdentities)) {
        digest.toolIdentities = m.toolIdentities
          .filter(
            (t: any) => t && typeof t.id === "string" && typeof t.name === "string",
          )
          .map((t: any) => ({ id: t.id, name: t.name }));
      }
      if (typeof m.nonToolDigest === "string") {
        digest.nonToolDigest = m.nonToolDigest;
      }
    }
    messageDigests.push(digest);
  }
  return {
    nativeSessionId: e.nativeSessionId,
    accountRef: e.accountRef,
    minimalAgent: e.minimalAgent,
    workDir: typeof e.workDir === "string" ? e.workDir : undefined,
    parkedAt: e.parkedAt,
    systemPromptDigest: e.systemPromptDigest,
    toolsDigests,
    messageDigests,
  };
}

const STORAGE_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
  private persistedSessions = new Map<string, PersistedParkedSession>();
  private persistedSessionsFile: string | null = null;
  private lastStorageGcAt = 0;

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

    const prevReapTick = this.scheduler.onReapTick;
    this.scheduler.onReapTick = (now: number) => {
      try {
        prevReapTick?.(now);
      } catch {}
      this.pruneParkedSessions(now);
      if (now - this.lastStorageGcAt >= STORAGE_GC_INTERVAL_MS) {
        this.lastStorageGcAt = now;
        this.sweepAccountStorage(now);
      }
    };
  }

  sweepAccountStorage(now = Date.now()): void {
    const protectedSessionIds = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      if (worker.nativeSessionId) protectedSessionIds.add(worker.nativeSessionId);
      if (worker.sessionId) protectedSessionIds.add(worker.sessionId);
    }
    for (const entry of this.parkedSessions.values()) {
      if (entry.nativeSessionId) protectedSessionIds.add(entry.nativeSessionId);
    }
    try {
      this.ensurePersistedSessionsLoaded(now);
    } catch {}
    for (const entry of this.persistedSessions.values()) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) continue;
      if (entry.nativeSessionId) protectedSessionIds.add(entry.nativeSessionId);
    }
    try {
      sweepStaleAccountStorage({ now, protectedSessionIds });
    } catch {}
  }

  /**
   * Loads the on-disk digest index lazily and reloads it whenever the active
   * plugin data root changes (tests switch `AGY_ACP_DATA_DIR` between cases).
   */
  private ensurePersistedSessionsLoaded(now = Date.now()): void {
    let file: string;
    try {
      file = path.join(getPluginDataRoot(), "parked-sessions.json");
    } catch {
      return;
    }
    if (this.persistedSessionsFile === file) return;
    this.persistedSessionsFile = file;
    this.persistedSessions = new Map<string, PersistedParkedSession>();
    try {
      const parsed: any = JSON.parse(fs.readFileSync(file, "utf8"));
      const sessions = parsed?.sessions;
      if (sessions && typeof sessions === "object") {
        for (const [key, raw] of Object.entries(
          sessions as Record<string, unknown>,
        )) {
          const entry = normalizePersistedEntry(raw);
          if (entry) this.persistedSessions.set(key, entry);
        }
      }
    } catch {}
    this.prunePersistedSessions(now);
  }

  private prunePersistedSessions(now = Date.now()): void {
    for (const [key, entry] of this.persistedSessions) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) {
        this.persistedSessions.delete(key);
      }
    }
    while (this.persistedSessions.size > MAX_PARKED_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.persistedSessions) {
        if (entry.parkedAt < oldestAt) {
          oldestAt = entry.parkedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.persistedSessions.delete(oldestKey);
    }
  }

  /**
   * Atomically writes the digest index (mode 0o600). Never throws: disk errors
   * must not break a turn.
   */
  private flushPersistedSessions(now = Date.now()): void {
    try {
      this.ensurePersistedSessionsLoaded(now);
      const file = this.persistedSessionsFile;
      if (!file) return;
      this.prunePersistedSessions(now);
      const payload = JSON.stringify(
        { version: 1, sessions: Object.fromEntries(this.persistedSessions) },
        null,
        2,
      );
      const tmpFile = `${file}.${process.pid}.${crypto
        .randomBytes(6)
        .toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmpFile, payload, { mode: 0o600 });
        try {
          fs.chmodSync(tmpFile, 0o600);
        } catch {}
        fs.renameSync(tmpFile, file);
      } catch (err) {
        try {
          fs.rmSync(tmpFile, { force: true });
        } catch {}
        throw err;
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {}
    } catch {}
  }

  private invalidatePersistedSession(
    sessionKey: string,
    nativeSessionId?: string,
    now = Date.now(),
  ): void {
    try {
      this.ensurePersistedSessionsLoaded(now);
      let removed = this.persistedSessions.delete(sessionKey);
      if (nativeSessionId) {
        for (const [k, entry] of this.persistedSessions) {
          if (entry.nativeSessionId === nativeSessionId) {
            this.persistedSessions.delete(k);
            removed = true;
          }
        }
      }
      if (removed) {
        this.flushPersistedSessions(now);
      }
    } catch {}
  }

  /**
   * Records a digest-only index entry for a stateful session that can be woken
   * with `session/resume`. Never stores message text, tool args/results, system
   * prompt text, or the system history seed.
   */
  private recordPersistedSession(
    worker: AgySessionWorker,
    sessionKey: string,
    now = Date.now(),
  ): void {
    try {
      if (worker.appliedSystemHistorySeed) return;
      if (!worker.resumeSupported) return;
      if (!worker.nativeSessionId) return;
      if (worker.sessionId.startsWith("ephemeral-")) return;
      this.ensurePersistedSessionsLoaded(now);
      this.persistedSessions.set(sessionKey, {
        nativeSessionId: worker.nativeSessionId,
        accountRef: worker.account.accountRef,
        minimalAgent: worker.minimalAgent,
        workDir: worker.workDir,
        parkedAt: now,
        systemPromptDigest: sha256Hex(
          stripVolatileSystem(worker.systemPrompt ?? ""),
        ),
        toolsDigests: digestToolsForPersistence(worker.registeredTools),
        messageDigests: digestMessagesForPersistence(worker.committedMessages),
      });
      this.flushPersistedSessions(now);
    } catch {}
  }

  private resolvePersistedResume(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    requestedMinimalAgent: boolean,
    now: number,
    spawnFn: TurnExecutionOptions["spawnFn"],
  ): PersistedParkedSession | null {
    try {
      this.ensurePersistedSessionsLoaded(now);
    } catch {
      return null;
    }
    const entry = this.persistedSessions.get(sessionKey);
    if (!entry) return null;
    if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) return null;
    if (entry.accountRef !== account.accountRef) return null;
    if (entry.minimalAgent !== requestedMinimalAgent) return null;
    if (entry.systemPromptDigest !== sha256Hex(stripVolatileSystem(req.system))) {
      return null;
    }
    if (!toolsMatchPersistedDigests(entry.toolsDigests, req.tools)) return null;
    if (!persistedPrefixMatches(entry.messageDigests, req.messages)) return null;
    if (!spawnFn) {
      const dbPath = resolveConversationDbPath(account, entry.nativeSessionId);
      if (!dbPath || !fs.existsSync(dbPath)) return null;
    }
    return entry;
  }

  private removeActiveWorker(worker: AgySessionWorker): void {
    for (const [key, w] of this.activeWorkers) {
      if (w === worker) {
        this.activeWorkers.delete(key);
      }
    }
  }

  pruneParkedSessions(now = Date.now()): void {
    let totalBytes = 0;
    for (const [key, entry] of this.parkedSessions) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) {
        this.parkedSessions.delete(key);
      } else {
        totalBytes += entry.estimatedBytes;
      }
    }
    while (
      this.parkedSessions.size > MAX_PARKED_SESSIONS ||
      totalBytes > MAX_TOTAL_PARKED_BYTES
    ) {
      const oldestKey = this.parkedSessions.keys().next().value;
      if (!oldestKey) break;
      const victim = this.parkedSessions.get(oldestKey);
      this.parkedSessions.delete(oldestKey);
      if (victim) {
        totalBytes = Math.max(0, totalBytes - victim.estimatedBytes);
      }
    }
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
    const now = Date.now();
    this.pruneParkedSessions(now);
    if (worker.resumeSupported && !worker.appliedSystemHistorySeed) {
      this.recordPersistedSession(worker, foundKey, now);
    }
    if (worker.nativeSessionId) {
      const estimatedBytes = estimateParkedBytes(
        worker.committedMessages,
        worker.systemPrompt,
        worker.appliedSystemHistorySeed,
        worker.registeredTools,
      );
      if (estimatedBytes > MAX_SINGLE_PARKED_BYTES) {
        this.parkedSessions.delete(foundKey);
        return;
      }
      this.parkedSessions.delete(foundKey);
      this.parkedSessions.set(foundKey, {
        nativeSessionId: worker.nativeSessionId,
        committedMessages: [...worker.committedMessages],
        systemPrompt: worker.systemPrompt,
        systemHistorySeed: worker.appliedSystemHistorySeed,
        minimalAgent: worker.minimalAgent,
        registeredTools: [...worker.registeredTools],
        workDir: worker.workDir,
        resumeSupported: worker.resumeSupported,
        parkedAt: now,
        estimatedBytes,
      });
      this.pruneParkedSessions(now);
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

    const requestedMinimalAgent = Boolean(
      options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
    );

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
    if (!existingWorker) {
      existingWorker = this.adoptAwaitingToolWorker(
        account,
        req,
        sessionKey,
        requestedMinimalAgent,
      );
    }

    const baseWorker =
      this.activeWorkers.get(baseSessionKey) ??
      (existingWorker && !req.subagentId ? existingWorker : undefined);

    const lastMessage = req.messages[req.messages.length - 1];
    const answersPendingTool = Boolean(
      baseWorker &&
        baseWorker.state === "AWAITING_TOOL_RESULTS" &&
        lastMessage?.role === "user" &&
        lastMessage.content.some((p) => p.type === "tool_result"),
    );

    const isSideRequest = Boolean(
      baseWorker &&
        baseWorker.registeredTools.length > 0 &&
        !answersPendingTool &&
        (req.tools.length === 0 || req.toolChoice.type === "none"),
    );

    if (isSideRequest && baseWorker) {
      validateNoOrphanToolResults(req.messages);
      const prevPinned = baseWorker.pinned;
      // Prefer evicting any OTHER idle session before evicting the parent session
      // whose title/classifier side request is currently running.
      const active = this.scheduler.getActiveWorkers();
      const acctWorkers = active.filter(
        (w) =>
          w.account.accountRef === account.accountRef &&
          w.account.slotKey === account.slotKey,
      );
      const canSpareAccountSlot =
        acctWorkers.length < this.scheduler.maxPerAccountWorkers ||
        acctWorkers.some((w) => w !== baseWorker && !w.pinned && w.state === "IDLE");
      const canSpareGlobalSlot =
        active.length < this.scheduler.maxGlobalWorkers ||
        active.some((w) => w !== baseWorker && !w.pinned && w.state === "IDLE");
      if (canSpareAccountSlot && canSpareGlobalSlot) {
        baseWorker.pinned = true;
      }
      try {
        yield* this.executeStatelessTurn(
          account,
          req,
          modelSelection,
          options,
          signal,
        );
      } finally {
        baseWorker.pinned = prevPinned;
      }
      return;
    }

    if (
      existingWorker &&
      existingWorker.account.accountRef !== account.accountRef
    ) {
      this.removeActiveWorker(existingWorker);
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("account_mismatch");
      existingWorker = undefined;
    }

    if (existingWorker && existingWorker.minimalAgent !== requestedMinimalAgent) {
      this.removeActiveWorker(existingWorker);
      this.scheduler.unregisterWorker(existingWorker);
      await existingWorker.close("system_prompt_mode_changed");
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
        sessionKey,
        signal,
      );
      return;
    }

    // Case 4: Warm IDLE session where history diverged/compacted or tools changed
    if (existingWorker && existingWorker.state === "IDLE") {
      this.removeActiveWorker(existingWorker);
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

  private adoptAwaitingToolWorker(
    account: AccountDescriptor,
    req: NormalizedAnthropicRequest,
    sessionKey: string,
    requestedMinimalAgent: boolean,
  ): AgySessionWorker | undefined {
    const lastMsg = req.messages[req.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user") return undefined;

    const incomingToolUseIds = new Set<string>();
    for (const part of lastMsg.content) {
      if (part.type === "tool_result") {
        incomingToolUseIds.add(part.toolUseId);
      }
    }
    if (incomingToolUseIds.size === 0) return undefined;

    for (const candidate of this.activeWorkers.values()) {
      if (candidate.pinned) continue;
      if (candidate.state !== "AWAITING_TOOL_RESULTS") continue;
      if (
        candidate.account.slotKey !== account.slotKey ||
        candidate.account.accountRef !== account.accountRef
      ) {
        continue;
      }
      if (candidate.minimalAgent !== requestedMinimalAgent) continue;

      const pendingIds = candidate.broker.getExposedPendingIds();
      if (!pendingIds.some((id) => incomingToolUseIds.has(id))) continue;

      if (!req.subagentId) {
        const diffSystem =
          stripVolatileSystem(req.system) !==
          stripVolatileSystem(candidate.systemPrompt);
        const diffOpening =
          getOpeningUserText(req.messages) !==
          getOpeningUserText(candidate.committedMessages);
        if (diffSystem && diffOpening) continue;
      }

      const prefixLen = candidate.committedMessages.length;
      const matchesPrefix =
        req.messages.length >= prefixLen &&
        isPrefixMatch(
          candidate.committedMessages,
          req.messages.slice(0, prefixLen),
        );
      if (
        !matchesPrefix &&
        !isCompactedRequest(req.messages, candidate.committedMessages, candidate)
      ) {
        continue;
      }

      this.removeActiveWorker(candidate);
      if (req.sessionId) {
        candidate.sessionId = req.sessionId;
      }
      this.activeWorkers.set(sessionKey, candidate);
      return candidate;
    }

    return undefined;
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

    const requestedMinimalAgent = Boolean(
      options?.providerOptions?.minimalAgent ??
        this.providerOptions?.minimalAgent ??
        false,
    );
    const now = Date.now();
    this.pruneParkedSessions(now);
    const parked = this.parkedSessions.get(sessionKey);
    let resumeSessionId: string | undefined = undefined;
    if (
      parked &&
      now - parked.parkedAt < PARKED_SESSION_TTL_MS &&
      parked.minimalAgent === requestedMinimalAgent &&
      stripVolatileSystem(parked.systemPrompt) ===
        stripVolatileSystem(req.system) &&
      isToolSetCompatible(parked.registeredTools, req.tools) &&
      isPrefixMatch(parked.committedMessages, req.messages)
    ) {
      resumeSessionId = parked.nativeSessionId;
    }

    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
    // Cross-restart resume: fall back to the digest-only on-disk index when the
    // in-memory shelf is empty (fresh plugin host / SIGKILLed host / update).
    let persisted: PersistedParkedSession | null = null;
    if (!resumeSessionId) {
      persisted = this.resolvePersistedResume(
        account,
        req,
        sessionKey,
        requestedMinimalAgent,
        now,
        spawnFn,
      );
      if (persisted) resumeSessionId = persisted.nativeSessionId;
    }

    const { priorMessages, currentMessages } = splitPriorAndCurrent(
      req.messages,
    );
    const coldPlan = planColdHistoryRender(
      priorMessages,
      currentMessages,
      modelSelection.rawModelId,
    );
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
      resumeSystemHistorySeed: resumeSessionId
        ? parked?.systemHistorySeed
        : undefined,
      systemPrompt: req.system,
      systemHistorySeed: coldPlan.systemHistorySeed,
      tools: req.tools,
      toolChoice: req.toolChoice,
      steerCancelTimeoutMs:
        options?.steerCancelTimeoutMs ??
        this.options?.steerCancelTimeoutMs,
      onStateChange: (_worker, _oldState, newState) => {
        if (newState === "CLOSED") {
          this.removeActiveWorker(_worker);
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
        this.removeActiveWorker(worker);
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
          sessionKey,
          signal,
        );
        return;
      }

      if (worker.resumedFromShelf && persisted) {
        // Rebuild the ledger from the persisted digest length only; the digests
        // prove this prefix is byte-identical to the pre-restart conversation.
        worker.committedMessages = req.messages.slice(
          0,
          persisted.messageDigests.length,
        );
        yield* this.executeWarmIdleTurn(
          worker,
          req,
          modelSelection,
          sessionKey,
          signal,
        );
        return;
      }

      if (persisted && !worker.resumedFromShelf) {
        // Resume was rejected by the agent (or its .db vanished): drop the stale
        // index entry and continue with a normal cold start.
        this.persistedSessions.delete(sessionKey);
        this.flushPersistedSessions();
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

      const promptParts = worker.systemHistorySeedApplied
        ? renderMessagesToPrompt(coldPlan.tailPriorMessages, currentMessages, {
            priorSeededInSystem: true,
            imageSourceMessages: priorMessages,
          })
        : renderMessagesToPrompt(priorMessages, currentMessages);
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

      if (worker.effectiveSystemPrompt && !worker.appendSystemSupported) {
        const sysPrompt = `<external_system_instructions>\n${worker.effectiveSystemPrompt}\n</external_system_instructions>\n\n`;
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

      let sawError = false;
      this.invalidatePersistedSession(sessionKey, worker.nativeSessionId);
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        if (event.type === "tool_use") {
          generatedToolCalls.push(event);
        } else if (event.type === "text_delta") {
          fullAnswerText += event.text;
        } else if (event.type === "error") {
          sawError = true;
        } else if (event.type === "finish") {
          commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
          if (generatedToolCalls.length === 0) {
            this.recordPersistedSession(worker, sessionKey);
          }
        }
        yield event;
      }

      if (sawError) {
        this.removeActiveWorker(worker);
        this.scheduler.unregisterWorker(worker);
        await worker.close("turn_error");
      }
    } finally {
      worker.pinned = false;
    }
  }

  private async *executeWarmIdleTurn(
    worker: AgySessionWorker,
    req: NormalizedAnthropicRequest,
    modelSelection: ModelSelection,
    sessionKey: string,
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

      let sawError = false;
      this.invalidatePersistedSession(sessionKey, worker.nativeSessionId);
      for await (const event of worker.startPromptTurn(promptParts, signal)) {
        if (event.type === "tool_use") {
          generatedToolCalls.push(event);
        } else if (event.type === "text_delta") {
          fullAnswerText += event.text;
        } else if (event.type === "error") {
          sawError = true;
        } else if (event.type === "finish") {
          commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
          if (generatedToolCalls.length === 0) {
            this.recordPersistedSession(worker, sessionKey);
          }
        }
        yield event;
      }

      if (sawError) {
        for (const [k, w] of this.activeWorkers) {
          if (w === worker) this.activeWorkers.delete(k);
        }
        this.scheduler.unregisterWorker(worker);
        await worker.close("turn_error");
      }
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
          this.removeActiveWorker(worker);
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
      let sawError = false;
      this.invalidatePersistedSession(sessionKey, worker.nativeSessionId);
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
          } else if (event.type === "error") {
            sawError = true;
          } else if (event.type === "finish") {
            commitAssistantTurn(worker, req, fullAnswerText, generatedToolCalls);
            if (generatedToolCalls.length === 0) {
              this.recordPersistedSession(worker, sessionKey);
            }
          }
          yield event;
        }
      } catch (err) {
        if (err instanceof SteerReplayNeededError && !yieldedAny) {
          this.removeActiveWorker(worker);
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

      if (sawError) {
        this.removeActiveWorker(worker);
        this.scheduler.unregisterWorker(worker);
        await worker.close("turn_error");
      }
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
    const ephemeralSessionId = `ephemeral-${crypto.randomUUID()}`;
    const spawnFn = options?.spawnFn ?? this.defaultSpawnFn;
    const { priorMessages, currentMessages } = splitPriorAndCurrent(
      req.messages,
    );
    const coldPlan = planColdHistoryRender(
      priorMessages,
      currentMessages,
      modelSelection.rawModelId,
    );
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
        cloakPrompts:
          options?.providerOptions?.cloakPrompts ??
          this.providerOptions?.cloakPrompts ??
          true,
        workDir: req.workDir,
        systemPrompt: req.system,
        systemHistorySeed: coldPlan.systemHistorySeed,
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

      const promptParts = worker.systemHistorySeedApplied
        ? renderMessagesToPrompt(coldPlan.tailPriorMessages, currentMessages, {
            priorSeededInSystem: true,
            imageSourceMessages: priorMessages,
          })
        : renderMessagesToPrompt(priorMessages, currentMessages);
      if (worker.effectiveSystemPrompt && !worker.appendSystemSupported) {
        const sysPrompt = `<external_system_instructions>\n${worker.effectiveSystemPrompt}\n</external_system_instructions>\n\n`;
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
