// Transcript ledger: canonical message normalization, prefix matching (with
// `lostMedia` tolerance for clients that strip earlier turns' images), tool-set
// compatibility, and the single SHA-256 digest representation shared by the
// in-memory shelf and the on-disk resume index.
//
// Extracted from `coordinator.ts` (ARCH-1) so the rules live in one deep module
// instead of two drifting copies: the live matcher (`isPrefixMatch`) and the
// persisted digest matcher (`matchPersistedPrefix`) are built from the same
// canonical representation and the same `lostMedia` comparison.
//
// `lostMedia` is a faithful port of Magpie's
// `internal/gateway/claude_lost_media.go` (MIT, yetone/magpie). Its purpose:
// a client may send its conversation back with the images and files of earlier
// messages taken out — replaced by a line of text, or an image-only message
// dropped entirely. The native session still holds them, and nothing else
// changed, so the conversation goes on instead of being replayed into a fresh
// session (which would write the whole history to the prompt cache again).

import crypto from "node:crypto";
import {
  BridgeHttpError,
  type NormalizedContentPart,
  type NormalizedMessage,
  type ToolChoiceSpec,
} from "../types";
import {
  stripVolatileMessageText,
  stripVolatileSystem,
} from "../protocol/cloak";

// ---------------------------------------------------------------------------
// Tool definition shape
// ---------------------------------------------------------------------------

/** A caller tool as the broker/worker keep it. */
export interface ToolDefLike {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Key-order-independent JSON, so digests never depend on insertion order. */
export function stableJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val) ?? "null";
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = val as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stableJson(record[key])}`,
  );
  return `{${pairs.join(",")}}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function utf8Bytes(str: string): number {
  return Buffer.byteLength(str, "utf-8");
}

/**
 * The subagent a session key was registered under.
 *
 * Subagents share their parent's session id, so the key carries the distinction
 * (`<slot>::<account>::<sessionId>::sub:<id>`) and any adoption or lookup has to
 * honour it.
 */
export function subagentIdFromSessionKey(key: string): string | undefined {
  const idx = key.indexOf("::sub:");
  return idx >= 0 ? key.slice(idx + 6) : undefined;
}

/**
 * Normalizes a caller workspace for comparison. `worker.workDir` feeds both
 * `--add-dir` and the workDir disambiguation note at startup, so two requests
 * with different workDir must never share a native session.
 */
export function normalizeWorkDir(dir?: string): string | undefined {
  if (typeof dir !== "string") return undefined;
  if (/[\r\n\0]/.test(dir)) return undefined;
  const trimmed = dir.trim();
  return trimmed ? trimmed : undefined;
}

/** Stable system-prompt identity: rotating billing headers/clocks are ignored. */
export function systemPromptsMatch(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  return stripVolatileSystem(a) === stripVolatileSystem(b);
}

export function getOpeningUserText(messages: NormalizedMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  const raw = firstUser.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
  return stripVolatileMessageText(raw).trim();
}

export function getToolChoiceReminder(
  toolChoice?: ToolChoiceSpec,
): string | null {
  if (!toolChoice) return null;
  if (toolChoice.type === "any") {
    return "<system-reminder>\nYou must call at least one tool in this turn.\n</system-reminder>";
  }
  if (toolChoice.type === "tool") {
    return `<system-reminder>\nYou must call the '${toolChoice.name}' tool in this turn.\n</system-reminder>`;
  }
  return null;
}

/**
 * The first `tool_result` whose `tool_use_id` has no earlier `tool_use`, or
 * `null` when the transcript is consistent.
 */
function firstOrphanToolResultId(
  messages: NormalizedMessage[],
): string | null {
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool_use") toolUseIds.add(part.id);
      }
    } else if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type === "tool_result" && !toolUseIds.has(part.toolUseId)) {
          return part.toolUseId;
        }
      }
    }
  }
  return null;
}

export function validateNoOrphanToolResults(
  messages: NormalizedMessage[],
): void {
  const orphanId = firstOrphanToolResultId(messages);
  if (orphanId !== null) {
    throw new BridgeHttpError(
      400,
      "invalid_request_error",
      `Orphan tool_result with tool_use_id '${orphanId}' has no matching prior tool_use`,
    );
  }
}

export function hasNoOrphanToolResults(
  messages: NormalizedMessage[],
): boolean {
  return firstOrphanToolResultId(messages) === null;
}

/** True when the transcript ends with `assistant(tool_use)` + matching results. */
export function endsWithMatchingToolPair(
  messages: NormalizedMessage[],
  pendingIds: string[],
): boolean {
  if (messages.length < 2) return false;
  const assistantMsg = messages[messages.length - 2]!;
  const userMsg = messages[messages.length - 1]!;
  if (assistantMsg.role !== "assistant" || userMsg.role !== "user") {
    return false;
  }

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

// ---------------------------------------------------------------------------
// Canonical parts / prefix matching
// ---------------------------------------------------------------------------

/**
 * The ledger's canonical view of a message's parts: thinking blocks and
 * volatile `<system-reminder>` clocks are dropped, adjacent text is merged.
 *
 * Clients (Pi) also drop whitespace-only assistant text blocks such as `"\n\n"`
 * before a `tool_use`, so a whitespace-only text part never invalidates reuse.
 */
export function canonicalPartsForLedger(
  parts: NormalizedContentPart[],
): NormalizedContentPart[] {
  const filtered = parts.filter((p) => p.type !== "thinking");

  const merged: NormalizedContentPart[] = [];
  for (const p of filtered) {
    if (p.type === "text") {
      const stripped = stripVolatileMessageText(p.text);
      const last = merged[merged.length - 1];
      if (last && last.type === "text") {
        last.text += stripped;
      } else {
        merged.push({ type: "text", text: stripped });
      }
    } else {
      merged.push(p);
    }
  }

  return merged.filter((p) => {
    if (p.type === "text" && p.text.trim() === "" && merged.length > 1) {
      return false;
    }
    return true;
  });
}

function toolUseParts(
  parts: NormalizedContentPart[],
): Array<{ id: string; name: string }> {
  return parts
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
}

export function sameToolUseIdentities(
  pParts: NormalizedContentPart[],
  fParts: NormalizedContentPart[],
): boolean {
  const pTools = toolUseParts(pParts);
  const fTools = toolUseParts(fParts);
  if (pTools.length !== fTools.length) return false;
  for (let i = 0; i < pTools.length; i++) {
    if (pTools[i]!.id !== fTools[i]!.id || pTools[i]!.name !== fTools[i]!.name) {
      return false;
    }
  }
  return true;
}

/**
 * Exact ledger prefix match. `tool_use.input` differences are tolerated when
 * every `(id, name)` pair matches and the non-tool parts are identical: clients
 * persist the call they were handed with reordered keys or schema defaults added.
 */
export function isPrefixMatch(
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
        if (stableJson(pNonTool) === stableJson(fNonTool)) continue;
      }
      return false;
    }
  }
  return true;
}

/** A tool set is reusable only when names, descriptions and schemas all match. */
export function isToolSetCompatible(
  registered: ToolDefLike[],
  incoming: ToolDefLike[],
): boolean {
  if (registered.length !== incoming.length) return false;
  const regMap = new Map(registered.map((t) => [t.name, t]));
  for (const t of incoming) {
    const existing = regMap.get(t.name);
    if (!existing) return false;
    // `agy` caches tool definitions inside the native session, so a changed
    // description needs a fresh `tools/list` just like a changed schema.
    if ((existing.description ?? "") !== (t.description ?? "")) return false;
    if (stableJson(existing.inputSchema) !== stableJson(t.inputSchema)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// lostMedia (port of Magpie internal/gateway/claude_lost_media.go)
// ---------------------------------------------------------------------------

export type HeardPartKind = "text" | "tool_use" | "tool_result" | "image";

/**
 * One part of a message as `heardRuns` reads it: its kind, the hash and UTF-8
 * byte length of its collapsed words, and — for a tool result — how many images
 * it carried beside them.
 *
 * `words` is present only on the incoming (`now`) side; a sealed (`was`) run
 * keeps no text at all, which is what lets the persisted index stay
 * zero-plaintext.
 */
export interface HeardPart {
  kind: HeardPartKind;
  /** UTF-8 byte length of the collapsed `words`. */
  n: number;
  /** SHA-256 hex of the collapsed `words`. */
  sum: string;
  /** Number of images a `tool_result` carried (0 for other kinds). */
  media: number;
  /**
   * SHA-256 hex of each image a `tool_result` carried, in order. Digests only:
   * a parked session keeps no image bytes and no image text. Absent on entries
   * written before this field existed, which stay comparable.
   */
  mediaDigests?: string[];
  /** Present only on unsealed runs. */
  words?: string;
}

/** A role's messages in a row, as `hashMessages` merges them. */
export interface HeardRun {
  role: "user" | "assistant";
  parts: HeardPart[];
  /** Index of the last source message that contributed to this run. */
  endMessageIndex: number;
}

/** Go's `strings.Join(strings.Fields(s), " ")`. */
function collapseWords(s: string): string {
  return s
    .split(/\s+/)
    .filter((piece) => piece !== "")
    .join(" ");
}

function heardPartOf(
  kind: HeardPartKind,
  words: string,
  media: number,
  sealed: boolean,
  mediaDigests?: string[],
): HeardPart | null {
  if (words === "") return null;
  const part: HeardPart = {
    kind,
    n: utf8Bytes(words),
    sum: sha256Hex(words),
    media,
  };
  if (mediaDigests !== undefined && mediaDigests.length > 0) {
    part.mediaDigests = mediaDigests;
  }
  if (!sealed) part.words = words;
  return part;
}

/**
 * `msgs` as `lostMedia` compares them. `sealed` keeps no words (a run's own
 * record); the incoming side carries them so a growth can be verified.
 */
export function heardRuns(
  msgs: NormalizedMessage[],
  sealed: boolean,
): HeardRun[] {
  const out: HeardRun[] = [];
  let callSeq = 0;
  const calls = new Map<string, number>();

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;
    const parts: HeardPart[] = [];

    for (const part of msg.content) {
      let kind: HeardPartKind;
      let text: string;
      let media = 0;
      let mediaDigests: string[] | undefined;

      if (part.type === "text") {
        kind = "text";
        text = stripVolatileMessageText(part.text);
      } else if (part.type === "tool_use") {
        callSeq += 1;
        calls.set(part.id, callSeq);
        kind = "tool_use";
        text = `\u0001call ${part.name} #${callSeq}`;
      } else if (part.type === "tool_result") {
        const known = calls.get(part.toolUseId);
        const slot = known === undefined ? "?" : String(known);
        const inner: string[] = [];
        const digests: string[] = [];
        for (const item of part.content) {
          if (item.type === "text") {
            inner.push(stripVolatileMessageText(item.text));
          } else if (item.type === "image") {
            media += 1;
            digests.push(sha256Hex(item.data));
          }
        }
        if (digests.length > 0) mediaDigests = digests;
        kind = "tool_result";
        text = `\u0001result #${slot} ${inner.join(" ")}`;
      } else if (part.type === "image") {
        kind = "image";
        // The content digest, not just the length: two different images of the
        // same byte length must never hash to the same part.
        text = `\u0001image ${part.mediaType} ${part.data.length} ${sha256Hex(part.data)}`;
      } else {
        // thinking / redacted thinking: never part of the conversation's words.
        continue;
      }

      const heard = heardPartOf(kind, collapseWords(text), media, sealed, mediaDigests);
      if (heard) parts.push(heard);
    }

    if (parts.length === 0) continue;

    const last = out[out.length - 1];
    if (!last || last.role !== msg.role) {
      out.push({ role: msg.role, parts, endMessageIndex: i });
    } else {
      for (const part of parts) last.parts.push(part);
      last.endMessageIndex = i;
    }
  }

  return out;
}

function isMedia(kind: HeardPartKind): boolean {
  return kind === "image";
}

/** Same kind, same byte length, same word digest. */
function sameWords(was: HeardPart, now: HeardPart): boolean {
  return was.kind === now.kind && was.n === now.n && was.sum === now.sum;
}

/**
 * `now`'s part is `was`'s: same words *and* the same images.
 *
 * A sealed part carries no words, so the incoming side supplies them: it is the
 * same part when the incoming words hash to the recorded digest and their
 * length matches the recorded byte length. The media count and, when both sides
 * recorded them, the image digests have to agree too, otherwise adding or
 * swapping an image inside a `tool_result` whose text did not change would look
 * like an unchanged part.
 */
function samePart(was: HeardPart, now: HeardPart): boolean {
  if (!sameWords(was, now)) return false;
  if (was.media !== now.media) return false;
  return sameDigests(was.mediaDigests, now.mediaDigests);
}

/** Element-wise digest equality; a side that recorded nothing is trusted. */
function sameDigests(was?: string[], now?: string[]): boolean {
  if (was === undefined || now === undefined) return true;
  if (was.length !== now.length) return false;
  for (let i = 0; i < was.length; i += 1) {
    if (was[i] !== now[i]) return false;
  }
  return true;
}

/**
 * `now`'s images are an ordered subsequence of `was`'s: the images still there
 * are the ones that were there, in order, with the rest removed.
 */
function digestsRemain(was?: string[], now?: string[]): boolean {
  if (was === undefined || now === undefined) return true;
  let i = 0;
  for (const digest of now) {
    while (i < was.length && was[i] !== digest) i += 1;
    if (i >= was.length) return false;
    i += 1;
  }
  return true;
}

/** `nowWords` is `was`'s words with text added to their end. */
function grown(was: HeardPart, nowWords: string): boolean {
  const bytes = Buffer.from(nowWords, "utf8");
  if (bytes.length <= was.n) return false;
  // `was.n` was the byte length of a valid UTF-8 string, and `nowWords` grew it
  // at the end, so the prefix ends on a character boundary.
  return sha256Hex(bytes.subarray(0, was.n).toString("utf8")) === was.sum;
}

/**
 * The results at `was[idx]` are followed by images or files: the user message a
 * chat-completions client sends a tool's images in, a line of text before them.
 */
function mediaAfter(was: HeardPart[], idx: number): boolean {
  let k = idx + 1;
  while (k < was.length && was[k]!.kind === "tool_result") k++;
  if (k < was.length && was[k]!.kind === "text") k++;
  return k < was.length && isMedia(was[k]!.kind);
}

/** How many media parts were taken out of `was` to make `now`, and whether that is all. */
function lostFromRun(
  was: HeardPart[],
  now: HeardPart[],
): { lost: number; ok: boolean } {
  let lost = 0;
  let j = 0;
  // `grew`: a result of the results just before had text added.
  let grew = false;

  for (let i = 0; i < was.length; i++) {
    const w = was[i]!;
    const nowPart = now[j];
    const nowWords = nowPart?.words ?? "";

    if (nowPart && samePart(w, nowPart)) {
      if (w.kind !== "tool_result") grew = false;
      j++;
      continue;
    }

    if (isMedia(w.kind)) {
      // Gone, or text in its place: skip the text lines that replaced it, up to
      // the next part of `was` that is not an image.
      lost++;
      let next = i + 1;
      while (next < was.length && isMedia(was[next]!.kind)) next++;
      while (
        j < now.length &&
        now[j]!.kind === "text" &&
        (next === was.length || !samePart(was[next]!, now[j]!))
      ) {
        j++;
      }
      continue;
    }

    if (
      w.kind === "tool_result" &&
      nowPart &&
      nowPart.kind === "tool_result" &&
      w.media > nowPart.media &&
      sameWords(w, nowPart) &&
      digestsRemain(w.mediaDigests, nowPart.mediaDigests)
    ) {
      // Its images, nothing else changed: the text is still exactly the text
      // that was heard, so this is media removal and not a new result.
      lost += w.media - nowPart.media;
      j++;
      continue;
    }

    if (
      w.kind === "tool_result" &&
      nowPart &&
      nowPart.kind === "tool_result" &&
      w.media > nowPart.media &&
      grown(w, nowWords) &&
      digestsRemain(w.mediaDigests, nowPart.mediaDigests)
    ) {
      // Its images, text in their place.
      lost += w.media - nowPart.media;
      grew = true;
      j++;
      continue;
    }

    if (
      w.kind === "tool_result" &&
      nowPart &&
      nowPart.kind === "tool_result" &&
      w.media === nowPart.media &&
      mediaAfter(was, i) &&
      grown(w, nowWords)
    ) {
      // The images sent after the results, text in their place.
      grew = true;
      j++;
      continue;
    }

    if (
      w.kind === "text" &&
      grew &&
      i > 0 &&
      was[i - 1]!.kind === "tool_result" &&
      i + 1 < was.length &&
      isMedia(was[i + 1]!.kind)
    ) {
      // The line before the results' images, gone with them.
      continue;
    }

    return { lost, ok: false };
  }

  return { lost, ok: j === now.length };
}

/**
 * `now` is `was` with images or files taken out, and that alone, as far as `was`
 * goes: `now` may go on after it. Each image or file of `was` is in `now`, gone,
 * or replaced by text; a tool result may have text added to its end when it
 * carried images or the user message of images after it went.
 *
 * `incomingPrefixLength` is how many of the incoming messages `was` covers, so
 * the caller can tell a re-rendered prefix from a genuinely new turn.
 */
export function lostMedia(
  was: HeardRun[],
  now: HeardRun[],
): { matched: boolean; incomingPrefixLength: number } {
  const miss = { matched: false, incomingPrefixLength: 0 };
  if (was.length === 0 || now.length < was.length) return miss;

  let totalLost = 0;
  for (let i = 0; i < was.length; i++) {
    const wasRun = was[i]!;
    const nowRun = now[i]!;
    if (nowRun.role !== wasRun.role) return miss;
    const { lost, ok } = lostFromRun(wasRun.parts, nowRun.parts);
    if (!ok) return miss;
    totalLost += lost;
  }
  if (totalLost === 0) return miss;

  const last = now[was.length - 1]!;
  return { matched: true, incomingPrefixLength: last.endMessageIndex + 1 };
}

// ---------------------------------------------------------------------------
// Unified prefix matcher
// ---------------------------------------------------------------------------

export interface PrefixMatchResult {
  matched: boolean;
  /** How many incoming messages the committed prefix covers. */
  incomingPrefixLength: number;
  /** True when only images were taken out (see `lostMedia`). */
  viaLostMedia: boolean;
}

const NO_PREFIX_MATCH: PrefixMatchResult = {
  matched: false,
  incomingPrefixLength: 0,
  viaLostMedia: false,
};

/**
 * Matches a committed ledger against an incoming transcript: exact prefix
 * first, then `lostMedia`.
 */
export function matchLedgerPrefix(
  committed: NormalizedMessage[],
  incoming: NormalizedMessage[],
): PrefixMatchResult {
  if (committed.length === 0) {
    return { matched: true, incomingPrefixLength: 0, viaLostMedia: false };
  }
  if (isPrefixMatch(committed, incoming)) {
    return {
      matched: true,
      incomingPrefixLength: committed.length,
      viaLostMedia: false,
    };
  }
  const lm = lostMedia(heardRuns(committed, true), heardRuns(incoming, false));
  if (!lm.matched) return NO_PREFIX_MATCH;
  return {
    matched: true,
    incomingPrefixLength: lm.incomingPrefixLength,
    viaLostMedia: true,
  };
}

/**
 * Whether an incoming transcript is a compaction of the committed one: marker
 * text or a shorter self-consistent transcript ending in a matching tool pair.
 */
export function isCompactedRequest(
  incomingMessages: NormalizedMessage[],
  committedMessages: NormalizedMessage[],
  pendingIds: string[],
): boolean {
  if (incomingMessages.length === 0) return false;
  if (!hasNoOrphanToolResults(incomingMessages)) return false;

  // A transcript that still carries this ledger (even with earlier images taken
  // out) is the same conversation, not a compaction of it.
  if (matchLedgerPrefix(committedMessages, incomingMessages).matched) {
    return false;
  }

  if (!endsWithMatchingToolPair(incomingMessages, pendingIds)) return false;

  const firstMsg = incomingMessages[0]!;
  const hasMarker = firstMsg.content.some(
    (p) =>
      p.type === "text" &&
      (/<summary[\s>]/i.test(p.text) ||
        /<\/summary>/i.test(p.text) ||
        p.text
          .toLowerCase()
          .includes("conversation history before this point was compacted")),
  );
  if (hasMarker) return true;

  return incomingMessages.length < committedMessages.length;
}

// ---------------------------------------------------------------------------
// Committed ledger
// ---------------------------------------------------------------------------

export type GeneratedToolCall = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * The ledger a finished turn leaves behind. An assistant prefill (the request
 * ends with `role: "assistant"`) is *merged* into that message instead of
 * appending a second consecutive assistant message, because clients send the
 * completed reply back as one message and a two-message ledger would never
 * prefix-match again.
 */
export function buildCommittedMessages(
  reqMessages: NormalizedMessage[],
  fullAnswerText: string,
  generatedToolCalls: GeneratedToolCall[],
): NormalizedMessage[] {
  const last = reqMessages[reqMessages.length - 1];
  if (last && last.role === "assistant") {
    const mergedContent: NormalizedContentPart[] = [
      ...last.content,
      ...(fullAnswerText ? [{ type: "text" as const, text: fullAnswerText }] : []),
      ...generatedToolCalls,
    ];
    return [
      ...reqMessages.slice(0, -1),
      { role: "assistant", content: mergedContent },
    ];
  }
  return [
    ...reqMessages,
    {
      role: "assistant",
      content: [
        ...(fullAnswerText ? [{ type: "text" as const, text: fullAnswerText }] : []),
        ...generatedToolCalls,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Unified SHA-256 digests (live shelf + on-disk index)
// ---------------------------------------------------------------------------

export interface PersistedToolDigest {
  name: string;
  schemaDigest: string;
}

/**
 * Zero-plaintext description of one ledger message. `fullDigest` is the
 * canonical parts; an assistant adds its tool identities and a digest of the
 * non-tool parts so reordered `tool_use` keys still match.
 */
export interface PersistedParkedMessageDigest {
  role: "user" | "assistant";
  fullDigest: string;
  toolIdentities?: Array<{ id: string; name: string }>;
  nonToolDigest?: string;
}

/**
 * Zero-plaintext description of a resumable session, persisted to
 * `parked-sessions.json`. It never carries message text, tool arguments, tool
 * outputs, system prompt text, or the system history seed.
 */
export interface PersistedParkedSession {
  nativeSessionId: string;
  accountRef: string;
  /** Slot the entry was recorded for; enables content-hash lookup. */
  slotKey?: string;
  subagentId?: string;
  minimalAgent: boolean;
  workDir?: string;
  parkedAt: number;
  systemPromptDigest: string;
  toolsDigests: PersistedToolDigest[];
  messageDigests: PersistedParkedMessageDigest[];
  /**
   * Sealed `heardRuns` of the committed ledger, so a restarted host still
   * tolerates a client that stripped earlier turns' images.
   */
  heardRuns?: HeardRun[];
}

/**
 * Digest of a single tool definition. The description is part of the digest so
 * a description-only change also invalidates persisted reuse (the native
 * session keeps the tool definitions it fetched at `session/new`).
 */
export function toolDigestFor(tool: ToolDefLike): string {
  return sha256Hex(
    stableJson({
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }),
  );
}

export function digestToolsForPersistence(
  tools: ToolDefLike[],
): PersistedToolDigest[] {
  return tools.map((t) => ({ name: t.name, schemaDigest: toolDigestFor(t) }));
}

export function toolsMatchPersistedDigests(
  digests: PersistedToolDigest[],
  tools: ToolDefLike[],
): boolean {
  if (digests.length !== tools.length) return false;
  const byName = new Map(digests.map((d) => [d.name, d.schemaDigest]));
  for (const t of tools) {
    const existing = byName.get(t.name);
    if (!existing || existing !== toolDigestFor(t)) return false;
  }
  return true;
}

export function digestMessagesForPersistence(
  messages: NormalizedMessage[],
): PersistedParkedMessageDigest[] {
  return messages.map((msg) => {
    const pParts = canonicalPartsForLedger(msg.content);
    const fullDigest = sha256Hex(stableJson(pParts));
    if (msg.role !== "assistant") {
      return { role: "user" as const, fullDigest };
    }
    return {
      role: "assistant" as const,
      fullDigest,
      toolIdentities: toolUseParts(pParts),
      nonToolDigest: sha256Hex(
        stableJson(pParts.filter((p) => p.type !== "tool_use")),
      ),
    };
  });
}

/** Exact digest-prefix match, mirroring `isPrefixMatch`'s tool tolerance. */
export function persistedPrefixMatches(
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
      if (
        stableJson(toolUseParts(pParts)) ===
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

/**
 * Matches a persisted entry against an incoming transcript: exact digest prefix
 * first, then `lostMedia` over the entry's sealed runs when it has them.
 */
export function matchPersistedPrefix(
  entry: Pick<PersistedParkedSession, "messageDigests" | "heardRuns">,
  incoming: NormalizedMessage[],
): PrefixMatchResult {
  if (persistedPrefixMatches(entry.messageDigests, incoming)) {
    return {
      matched: true,
      incomingPrefixLength: entry.messageDigests.length,
      viaLostMedia: false,
    };
  }
  if (!entry.heardRuns || entry.heardRuns.length === 0) return NO_PREFIX_MATCH;
  const lm = lostMedia(entry.heardRuns, heardRuns(incoming, false));
  if (!lm.matched) return NO_PREFIX_MATCH;
  return {
    matched: true,
    incomingPrefixLength: lm.incomingPrefixLength,
    viaLostMedia: true,
  };
}

// ---------------------------------------------------------------------------
// Persisted-entry validation
// ---------------------------------------------------------------------------

/** A digest list off disk: `media` well-formed SHA-256 hex strings, or nothing. */
function normalizeDigests(raw: unknown, media: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.length !== media) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return undefined;
    out.push(value);
  }
  return out;
}

function normalizeHeardRuns(raw: unknown): HeardRun[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const kinds: HeardPartKind[] = ["text", "tool_use", "tool_result", "image"];
  const runs: HeardRun[] = [];
  for (const run of raw) {
    if (!run || typeof run !== "object") return undefined;
    const r = run as Record<string, any>;
    if (r.role !== "user" && r.role !== "assistant") return undefined;
    if (!Array.isArray(r.parts) || r.parts.length === 0) return undefined;
    if (
      typeof r.endMessageIndex !== "number" ||
      !Number.isInteger(r.endMessageIndex) ||
      r.endMessageIndex < 0
    ) {
      return undefined;
    }
    const parts: HeardPart[] = [];
    for (const part of r.parts) {
      if (!part || typeof part !== "object") return undefined;
      const p = part as Record<string, any>;
      if (!kinds.includes(p.kind)) return undefined;
      if (typeof p.n !== "number" || !Number.isInteger(p.n) || p.n < 0) {
        return undefined;
      }
      if (typeof p.sum !== "string" || p.sum === "") return undefined;
      if (typeof p.media !== "number" || !Number.isInteger(p.media)) {
        return undefined;
      }
      const normalized: HeardPart = { kind: p.kind, n: p.n, sum: p.sum, media: p.media };
      const digests = normalizeDigests(p.mediaDigests, p.media);
      if (digests) normalized.mediaDigests = digests;
      parts.push(normalized);
    }
    runs.push({ role: r.role, parts, endMessageIndex: r.endMessageIndex });
  }
  return runs;
}

/** Shape-validates one on-disk entry; anything unexpected is dropped. */
export function normalizePersistedEntry(
  raw: unknown,
): PersistedParkedSession | null {
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

  const toolsDigests: PersistedToolDigest[] = [];
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
            (t: any) =>
              t && typeof t.id === "string" && typeof t.name === "string",
          )
          .map((t: any) => ({ id: t.id, name: t.name }));
      }
      if (typeof m.nonToolDigest === "string") {
        digest.nonToolDigest = m.nonToolDigest;
      }
    }
    messageDigests.push(digest);
  }

  const entry: PersistedParkedSession = {
    nativeSessionId: e.nativeSessionId,
    accountRef: e.accountRef,
    minimalAgent: e.minimalAgent,
    workDir: typeof e.workDir === "string" ? e.workDir : undefined,
    parkedAt: e.parkedAt,
    systemPromptDigest: e.systemPromptDigest,
    toolsDigests,
    messageDigests,
  };
  if (typeof e.slotKey === "string" && e.slotKey) entry.slotKey = e.slotKey;
  if (typeof e.subagentId === "string" && e.subagentId) {
    entry.subagentId = e.subagentId;
  }
  const heard = normalizeHeardRuns(e.heardRuns);
  if (heard) entry.heardRuns = heard;
  return entry;
}
