// Prompt rendering: how a turn's transcript becomes what `agy` is told.
//
// Extracted from `coordinator.ts` (ARCH-1) so the byte budgets and the
// `session/prompt` shape live in one deep module instead of inside the routes
// that decide which session runs.
//
// Two budgets, both measured against `agy 1.5.8`:
//
//   * `MAX_PROMPT_BYTES` (112 KiB) — the user text of a single `session/prompt`.
//     `agy` truncates that text at ~128 KiB, silently, so anything long has to
//     be trimmed here or the tail (often the actual question) disappears.
//   * the `<prior_conversation_history>` seed (512 KiB) — `systemPrompt.append`
//     is *not* truncated, it fails the turn outright once the trajectory no
//     longer fits the model's budget (see `maxSystemHistorySeedBytes`).
//
// Inline images are fitted here too: a prompt part is the last place where an
// oversized image can still be made acceptable, and `fitInlineImage` is a no-op
// for anything that already fits.

import type { NormalizedMessage } from "../types";
import { fitInlineImage } from "../protocol/images";
import { utf8Bytes } from "./ledger";

// ---------------------------------------------------------------------------
// Byte budgets
// ---------------------------------------------------------------------------

const HISTORY_BLOCK_CLIP_BYTES = 12 * 1024;
const HISTORY_BLOCK_KEEP_BYTES = 4 * 1024;
const SEED_BLOCK_CLIP_BYTES = 64 * 1024;
const SEED_BLOCK_KEEP_BYTES = 24 * 1024;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

const MAX_PROMPT_BYTES = positiveIntFromEnv(
  "AGY_BRIDGE_MAX_PROMPT_BYTES",
  112 * 1024,
);

/**
 * Byte ceiling for the `_meta.antigravity.systemPrompt.append` cold-replay
 * block (system text plus `<prior_conversation_history>` seed together).
 *
 * Measured against `agy 1.5.8` with real accounts: a seed of 720,000 bytes of
 * text (162,071 input tokens, English) is accepted, 760,000 bytes fails with
 * `serializing trajectory: no messages fit within the context token budget`,
 * and 780,000 bytes and above fails with
 * `serializing trajectory: maxMessageTokens must be positive, got 0`. The
 * boundary tracks bytes rather than tokens: 720,000 bytes of CJK text (137,721
 * tokens) passes while 760,002 bytes of CJK text (about 145,000 tokens) fails.
 * The previous 2 MiB default sat far past that boundary, and every live failure
 * carried a ~1.24 MB seed.
 *
 * 512 KiB leaves room for the 112 KiB `session/prompt` tail and for tool and
 * agent scaffolding while staying well below the accepted size. The exact
 * native budget formula is not published, so this is a bounded mitigation, not
 * a proven ceiling for every model, effort level, or future `agy` build.
 */
const DEFAULT_MAX_SYSTEM_HISTORY_SEED_BYTES = 512 * 1024;
const GPT_OSS_MAX_SYSTEM_HISTORY_SEED_BYTES = 64 * 1024;

function maxSystemHistorySeedBytes(modelId: string): number {
  const override = positiveIntFromEnv("AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES", 0);
  if (override > 0) return override;
  return /gpt-oss/i.test(modelId)
    ? GPT_OSS_MAX_SYSTEM_HISTORY_SEED_BYTES
    : DEFAULT_MAX_SYSTEM_HISTORY_SEED_BYTES;
}

// ---------------------------------------------------------------------------
// UTF-8 helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HISTORY_RECORD_NOTE =
  "Note: <conversation_history> is a read-only record of earlier turns. Do not re-execute completed tool calls or mimic [Tool Use] text syntax; invoke real MCP tools when needed.\n";
const PRIOR_HISTORY_RECORD_NOTE =
  "Note: <prior_conversation_history> is a read-only record of earlier turns in this conversation. Do not re-execute completed tool calls or mimic [Tool Use] text syntax; invoke real MCP tools when needed.\n";
const SEEDED_ABOVE_NOTE =
  "[Earlier turns are preserved in <prior_conversation_history> above.]\n";
const CONTINUATION_NOTE =
  "(system note: continue your unfinished assistant reply below from the exact character where it stops, without repeating the prefix.)";

/** A prompt part as `agy`'s `session/prompt` takes it. */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function requestHasImages(messages: NormalizedMessage[]): boolean {
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
        .map((c) => (c as { text: string }).text)
        .join("\n");
      entryText += `[Tool Result: id: ${part.toolUseId}]:\n${clipHistoryText(txt, clipBytes, keepBytes)}\n[end of tool result]\n`;
    }
  }
  entryText += "\n";
  return entryText;
}

export function splitPriorAndCurrent(messages: NormalizedMessage[]): {
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

  const renderUser = (msg: NormalizedMessage): string => {
    let out = "";
    for (const part of msg.content) {
      if (part.type === "text") {
        out += `${part.text}\n`;
      } else if (part.type === "tool_result") {
        const txt = part.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n");
        out += `[Tool Result: id: ${part.toolUseId}]:\n${txt}\n[end of tool result]\n`;
      }
    }
    return out;
  };

  let turnText = "";
  if (isSingleWarmMessage) {
    turnText = renderUser(userMessages[0]!);
  } else {
    turnText = "<current_turn>\n";
    for (const msg of userMessages) turnText += renderUser(msg);
    turnText += "</current_turn>\n";
  }

  let prefillText = "";
  if (prefillMessage) {
    let prefillContent = "";
    for (const part of prefillMessage.content) {
      if (part.type === "text") prefillContent += part.text;
    }
    prefillText = `\n<assistant_prefill>\n${prefillContent}\n${CONTINUATION_NOTE}\n</assistant_prefill>\n`;
  }

  return { userMessages, turnText, prefillText };
}

/**
 * Splits a cold transcript between the `session/prompt` tail and the
 * `<prior_conversation_history>` seed.
 *
 * `systemBytes` is the system text that shares the append block with the seed,
 * so the seed can never push the append past the native budget.
 */
export function planColdHistoryRender(
  priorMessages: NormalizedMessage[],
  currentMessages: NormalizedMessage[],
  modelId: string,
  systemBytes = 0,
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
  const seedFooter = PRIOR_HISTORY_RECORD_NOTE + "</prior_conversation_history>";
  const maxAppendBytes = maxSystemHistorySeedBytes(modelId);
  const availableForSeed = Math.max(
    0,
    maxAppendBytes -
      utf8Bytes(seedHeader + seedFooter) -
      Math.max(0, systemBytes),
  );
  if (availableForSeed === 0) {
    // No room for a seed: keep the bounded prompt tail and drop the oldest
    // turns rather than appending a block that cannot carry anything.
    return { systemHistorySeed: undefined, tailPriorMessages };
  }

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

export interface RenderPromptOptions {
  priorSeededInSystem?: boolean;
  imageSourceMessages?: NormalizedMessage[];
}

/** Pushes an image part after fitting it, so `agy` never sees an oversized one. */
function pushImagePart(
  parts: PromptPart[],
  mediaType: string,
  data: string,
): void {
  const fitted = fitInlineImage(mediaType, data);
  parts.push({ type: "image", data: fitted.data, mimeType: fitted.mediaType });
}

export function renderMessagesToPrompt(
  priorMessages: NormalizedMessage[],
  currentMessages: NormalizedMessage[],
  opts?: RenderPromptOptions,
): PromptPart[] {
  const parts: PromptPart[] = [];

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

  const rendered = renderCurrentTurnParts(
    currentMessages,
    isSingleWarmMessage,
  );
  const userMessages = rendered.userMessages;
  const prefillText = rendered.prefillText;
  let turnText = rendered.turnText;

  const currentBytes = utf8Bytes(turnText + prefillText);
  let historyText = "";

  if (priorMessages.length === 0 && currentBytes > MAX_PROMPT_BYTES) {
    // A standalone oversized turn (typically a client's own compaction
    // request): clip inside its `<conversation>` body so the instructions after
    // it survive, else clip the middle of the text.
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
      leadBytes + historyEntries.reduce((sum, e) => sum + utf8Bytes(e), 0);

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
        pushImagePart(parts, part.mediaType, part.data);
      } else if (part.type === "tool_result") {
        for (const item of part.content) {
          if (item.type === "image") {
            pushImagePart(parts, item.mediaType, item.data);
          }
        }
      }
    }
  }

  return parts;
}

/** Exposed for tests that assert the prompt budget itself. */
export const PROMPT_BUDGET_BYTES = MAX_PROMPT_BYTES;
