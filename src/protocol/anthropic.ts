// Anthropic Messages API protocol boundary.
//
// This module is the only place that speaks "Anthropic wire format":
//
//   * `parseAnthropicRequest` turns an untrusted HTTP body into a
//     `NormalizedAnthropicRequest`, or throws `BridgeHttpError(400, ...)`.
//   * `encodeAnthropicSseResponse` / `collectAnthropicJsonResponse` turn the
//     normalized turn event stream produced by the runtime into either
//     Anthropic SSE or a non-streaming Messages JSON body.
//   * `jsonErrorResponse` is the single mapping from `BridgeHttpError` to an
//     Anthropic-shaped error body.
//
// Two honesty rules are load-bearing here (both are regressions in `agy-cli`):
//
//  1. `stream` is only `true` when the caller asked for it. A body without
//     `stream` must get `application/json`, never an SSE stream.
//  2. Errors keep their real HTTP status. A pre-stream 409/429/503 must not be
//     laundered into `200` (SSE) or `502` (JSON), and `invalid_request_error`
//     must stay a `400`.
//
// Parameters that the Antigravity ACP runtime cannot honour (`stop_sequences`)
// are rejected instead of being silently dropped: a caller that believes a stop
// sequence is enforced would get different text than it was promised. Forced
// `tool_choice` values (`any`/`tool`) are *not* rejected: they are validated
// against the declared tools and forwarded in their normalized form.
//
// Claude Code (>= 2.1.296) and OpenAI-Responses translators also inject a wide
// tail of things this module must tolerate rather than 400 on: mid-conversation
// `system`/`developer` messages (hook notices, workdir updates,
// `<task-notification>`, queued user messages), `ToolSearch` reference blocks and
// Anthropic server-tool result blocks. Those are normalized here, not refused.

import { createHmac, randomBytes } from "node:crypto";

import {
  BridgeHttpError,
  type EffortLevel,
  type NormalizedAnthropicRequest,
  type NormalizedContentPart,
  type ProviderOptionsState,
  type TokenUsageSummary,
  type ToolChoiceSpec,
  type TurnStreamEvent,
} from "../types";

/** Header carrying the caller's opaque session id (used for ACP session reuse). */
export const SESSION_ID_HEADER = "x-agy-session-id";

/** Header carrying an explicit effort override (lowest-precedence explicit source). */
export const EFFORT_HEADER = "x-magpie-effort";

/** Header naming the Claude Code subagent that issued the turn. */
export const SUBAGENT_HEADER = "x-magpie-subagent";

/** Claude Code's own subagent header, accepted as a fallback for `SUBAGENT_HEADER`. */
export const ALT_SUBAGENT_HEADER = "x-claude-code-agent-id";

/** Header carrying the working directory the turn was issued from. */
export const WORKDIR_HEADER = "x-magpie-work-dir";

/** Response header that tells Magpie's gateway the account sign-in expired. */
export const SIGN_IN_HEADER = "x-magpie-sign-in";

type ImageMediaType = Extract<NormalizedContentPart, { type: "image" }>["mediaType"];
type TextPart = Extract<NormalizedContentPart, { type: "text" }>;
type ToolResultContentPart = Extract<
  NormalizedContentPart,
  { type: "tool_result" }
>["content"][number];
type NormalizedTool = NormalizedAnthropicRequest["tools"][number];

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

const MODEL_PREFIXES = ["agy-acp/", "agy/"] as const;

const PING_INTERVAL_MS = 15_000;

/** Upper bound on the post-`finish` step that lets upstream generators complete. */
const FINISH_DRAIN_GUARD_MS = 1_000;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

const ZERO_USAGE: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** Minimal valid JSON schema used when a tool omits its parameters. */
function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): BridgeHttpError {
  return new BridgeHttpError(400, "invalid_request_error", message);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function usagePayload(usage: TokenUsageSummary | undefined): Record<string, number> {
  const resolved = usage ?? ZERO_USAGE;
  return {
    input_tokens: tokenCount(resolved.inputTokens),
    output_tokens: tokenCount(resolved.outputTokens),
    cache_read_input_tokens: tokenCount(resolved.cacheReadInputTokens),
    cache_creation_input_tokens: tokenCount(resolved.cacheCreationInputTokens),
  };
}

function createMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Request parsing: shared field parsers
// ---------------------------------------------------------------------------

function decodeJsonBody(rawBody: string | Uint8Array | null | undefined): Record<string, unknown> {
  let text: string;
  if (typeof rawBody === "string") {
    text = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    text = new TextDecoder().decode(rawBody);
  } else {
    throw invalidRequest("Invalid JSON request body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequest("Invalid JSON request body");
  }

  if (!isPlainObject(parsed)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return parsed;
}

function parseEffortLevel(value: unknown, field: string): EffortLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalidRequest(`${field} must be a string effort level`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if ((EFFORT_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as EffortLevel;
  }
  throw invalidRequest(
    `Unsupported effort level "${value}" in ${field}; expected one of ${EFFORT_LEVELS.join(", ")}`,
  );
}

/**
 * Claude Code appends `[1m]` to opt into the 1M-token context window: either at
 * the very end (`claude-opus-5-5-low[1m]`) or just before a `:effort` suffix
 * (`gemini-3.8-flash[1m]:high`). The marker is a client-side hint, never part of
 * the ACP model id.
 */
function stripContextSuffix(value: string): string {
  return value.replace(/\[1m\]/gi, "").trim();
}

function parseModelAndEffort(rawModel: unknown): { model: string; effort?: EffortLevel } {
  const requested = nonEmptyString(rawModel);
  if (requested === null) {
    throw invalidRequest("model is required and must be a non-empty string");
  }

  let model = stripContextSuffix(requested);
  for (const prefix of MODEL_PREFIXES) {
    if (model.startsWith(prefix)) {
      model = stripContextSuffix(model.slice(prefix.length));
      break;
    }
  }

  // "gemini-3.8-flash:high" -> base model + per-request effort override.
  let effort: EffortLevel | undefined;
  const separator = model.lastIndexOf(":");
  if (separator > 0) {
    const suffix = model.slice(separator + 1).trim().toLowerCase();
    const base = stripContextSuffix(model.slice(0, separator));
    if (base !== "" && (EFFORT_LEVELS as readonly string[]).includes(suffix)) {
      effort = suffix as EffortLevel;
      model = base;
    }
  }

  if (model === "") {
    throw invalidRequest("model is required and must be a non-empty string");
  }
  return effort === undefined ? { model } : { model, effort };
}

/** Heuristic budget_tokens -> effort mapping (only used when nothing explicit was set). */
function effortFromThinkingBudget(budget: unknown): EffortLevel | undefined {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return undefined;
  }
  if (budget <= 2_048) return "low";
  if (budget <= 8_192) return "medium";
  return "high";
}

function parseToolChoice(value: unknown, tools: NormalizedTool[]): ToolChoiceSpec {
  if (value === undefined || value === null) return { type: "auto" };

  if (typeof value === "string") {
    return toolChoiceFromType(value, undefined, undefined, tools);
  }

  if (!isPlainObject(value)) {
    throw invalidRequest("tool_choice must be a string or an object");
  }

  const type = value.type;
  if (typeof type !== "string") {
    throw invalidRequest('tool_choice object must include a string "type"');
  }
  const disableParallelToolUse =
    typeof value.disable_parallel_tool_use === "boolean"
      ? value.disable_parallel_tool_use
      : undefined;
  // OpenAI-translated clients nest the tool name: { type: "function", function: { name } }.
  const fn = isPlainObject(value.function) ? value.function : undefined;
  const name = nonEmptyString(value.name) ?? nonEmptyString(fn?.name) ?? undefined;
  return toolChoiceFromType(type.toLowerCase(), disableParallelToolUse, name, tools);
}

function toolChoiceFromType(
  rawType: string,
  disableParallelToolUse: boolean | undefined,
  name: string | undefined,
  tools: NormalizedTool[],
): ToolChoiceSpec {
  const type = rawType.trim().toLowerCase();
  switch (type) {
    case "auto":
      return disableParallelToolUse === undefined
        ? { type: "auto" }
        : { type: "auto", disableParallelToolUse };
    case "none":
      return { type: "none" };
    case "any":
    case "required":
      // "Call some tool" is meaningless without a tool catalog to choose from.
      if (tools.length === 0) {
        throw invalidRequest(
          `tool_choice "${rawType}" requires at least one declared tool`,
        );
      }
      return disableParallelToolUse === undefined
        ? { type: "any" }
        : { type: "any", disableParallelToolUse };
    case "tool":
    case "function": {
      if (name === undefined) {
        throw invalidRequest(
          `tool_choice "${rawType}" requires a non-empty tool "name"`,
        );
      }
      if (!tools.some((tool) => tool.name === name)) {
        throw invalidRequest(
          `tool_choice names unknown tool "${name}"; it must match one of the declared tools`,
        );
      }
      return disableParallelToolUse === undefined
        ? { type: "tool", name }
        : { type: "tool", name, disableParallelToolUse };
    }
    default:
      throw invalidRequest(
        `Unsupported tool_choice type "${rawType}"; use auto, any, tool, or none`,
      );
  }
}

function extractSystemPrompt(system: unknown): string {
  if (system === undefined || system === null) return "";

  if (typeof system === "string") {
    return system;
  }

  if (isPlainObject(system)) {
    const text = system.text;
    const type = system.type;
    if (type !== undefined && type !== "text") {
      throw invalidRequest(`Unsupported system block type "${String(type)}"`);
    }
    return typeof text === "string" ? text : "";
  }

  if (!Array.isArray(system)) {
    throw invalidRequest("system must be a string or an array of text blocks");
  }

  const segments: string[] = [];
  for (const block of system) {
    if (typeof block === "string") {
      if (block.trim() !== "") segments.push(block);
      continue;
    }
    if (!isPlainObject(block)) {
      throw invalidRequest("system blocks must be objects or strings");
    }
    const type = block.type;
    if (type !== undefined && type !== "text") {
      throw invalidRequest(
        `Unsupported system block type "${String(type)}"; system prompts only support text`,
      );
    }
    if (typeof block.text === "string" && block.text.trim() !== "") {
      segments.push(block.text);
    }
  }
  return segments.join("\n\n");
}

/** System prompt carried as leading `role: "system"` messages by translated clients. */
function extractSystemTextFromMessage(content: unknown, index: number): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw invalidRequest(`messages[${index}].content must be a string or an array of text blocks`);
  }
  const segments: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim() !== "") segments.push(block);
      continue;
    }
    if (!isPlainObject(block)) {
      throw invalidRequest(`messages[${index}] system content blocks must be objects`);
    }
    const type = block.type;
    if (type !== undefined && type !== "text") {
      throw invalidRequest(
        `Unsupported system message content type "${String(type)}"; only text is supported`,
      );
    }
    if (typeof block.text === "string" && block.text.trim() !== "") {
      segments.push(block.text);
    }
  }
  return segments.join("\n\n");
}

/**
 * Claude Code's steering envelope: a queued user message arrives wrapped in a
 * `<system-reminder>` (or as a mid-conversation `system`/`developer` message).
 * Unwrapping it lets the coordinator treat the text as genuine steering instead
 * of as an anonymous reminder.
 */
const QUEUED_USER_MESSAGE_RE =
  /^<system-reminder>\s*The user sent a new message while you were working:\s*([\s\S]*?)\s*<\/system-reminder>$/i;

/**
 * A mid-conversation `system`/`developer` message (hook notice, working-directory
 * update, `<task-notification>`, queued user message) becomes a `user` turn:
 * ACP has exactly one `user` role, and refusing these would 400 Claude Code.
 * Wrapping reminder-shaped content keeps adjacent-`user` merging clean.
 */
function convertMidConversationSystemMessage(
  content: unknown,
  index: number,
): TextPart | null {
  const text = extractSystemTextFromMessage(content, index).trim();
  if (text === "") return null;

  const queued = QUEUED_USER_MESSAGE_RE.exec(text);
  if (queued !== null) {
    const inner = (queued[1] ?? "").trim();
    // The wrapper itself carried the whole prompt: emit the user's words alone.
    return inner === "" ? null : { type: "text", text: inner };
  }

  if (/^<system-reminder\b/i.test(text)) return { type: "text", text };
  return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
}

// ---------------------------------------------------------------------------
// Request parsing: content parts
// ---------------------------------------------------------------------------

/**
 * Block types that Claude Code's `ToolSearch` and Anthropic's server tools emit
 * inside `content` / `tool_result` arrays. None of them map onto an ACP content
 * block, so they are rendered as readable text (or skipped) instead of 400ing.
 */
const RICH_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "tool_reference",
  "search_result",
  "tool_addition",
  "tool_removal",
  "server_tool_use",
  "mcp_tool_use",
  "web_search_tool_result",
  "mcp_tool_result",
  "code_execution_tool_result",
]);

/** Flattens whatever a tool-result-ish block carries into plain text. */
function renderBlockContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const segments: string[] = [];
    for (const entry of content) {
      if (typeof entry === "string") {
        segments.push(entry);
      } else if (isPlainObject(entry)) {
        if (typeof entry.text === "string") segments.push(entry.text);
        else if (typeof entry.content === "string") segments.push(entry.content);
        else segments.push(JSON.stringify(entry));
      }
    }
    return segments.join("\n");
  }
  if (content === undefined || content === null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

const TOOL_RESULT_BLOCK_LABELS: Readonly<Record<string, string>> = {
  web_search_tool_result: "Web search results",
  mcp_tool_result: "MCP tool result",
  code_execution_tool_result: "Code execution result",
};

/** Renders one rich block as text, or `null` when it carries nothing to say. */
function parseRichTextBlock(block: Record<string, unknown>, type: string): TextPart | null {
  switch (type) {
    case "tool_reference":
      return {
        type: "text",
        text: `Loaded tool: ${nonEmptyString(block.tool_name) ?? "unknown"}`,
      };
    case "search_result": {
      const title = nonEmptyString(block.title);
      const source = nonEmptyString(block.source);
      const body = renderBlockContent(block.content).trim();
      const lines = [title === null ? "Search result" : `Search result: ${title}`];
      if (source !== null) lines.push(`Source: ${source}`);
      if (body !== "") lines.push(body);
      return { type: "text", text: lines.join("\n") };
    }
    case "tool_addition":
    case "tool_removal":
      // Catalog deltas are already reflected in `tools`; nothing to replay.
      return null;
    case "server_tool_use":
    case "mcp_tool_use": {
      const name =
        nonEmptyString(block.name) ?? nonEmptyString(block.tool_name) ?? "unknown";
      const input = isPlainObject(block.input) ? JSON.stringify(block.input) : "";
      return {
        type: "text",
        text: input === "" ? `Tool call: ${name}` : `Tool call: ${name} ${input}`,
      };
    }
    default: {
      const label = TOOL_RESULT_BLOCK_LABELS[type];
      if (label === undefined) return null;
      const body = renderBlockContent(block.content).trim();
      return { type: "text", text: body === "" ? label : `${label}:\n${body}` };
    }
  }
}

function parseImageSource(
  source: unknown,
  context: string,
): { mediaType: ImageMediaType; data: string } {
  if (!isPlainObject(source)) {
    throw invalidRequest(`${context}: image block must include a "source" object`);
  }

  const sourceType = source.type;
  if (sourceType === "url") {
    throw invalidRequest(
      `${context}: URL image sources are not supported by the Antigravity ACP runtime; send base64 data instead`,
    );
  }
  if (sourceType !== "base64") {
    throw invalidRequest(
      `${context}: unsupported image source type "${String(sourceType)}"; only "base64" is supported`,
    );
  }

  const mediaType = source.media_type;
  if (typeof mediaType !== "string" || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw invalidRequest(
      `${context}: unsupported image media type "${String(mediaType)}"; supported types are ${IMAGE_MEDIA_TYPES.join(", ")}`,
    );
  }

  const data = source.data;
  if (typeof data !== "string" || data.trim() === "") {
    throw invalidRequest(`${context}: base64 image data must be a non-empty string`);
  }
  const normalized = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized)) {
    throw invalidRequest(`${context}: image data must be valid base64`);
  }

  return { mediaType: mediaType as ImageMediaType, data: normalized };
}

function parseDocumentPart(block: Record<string, unknown>): NormalizedContentPart {
  const source = block.source;

  if (isPlainObject(source)) {
    const sourceType = source.type;
    if (sourceType === "text") {
      const text =
        typeof source.data === "string"
          ? source.data
          : typeof block.text === "string"
            ? block.text
            : "";
      return { type: "text", text };
    }
    if (sourceType === "base64" || sourceType === "content") {
      throw invalidRequest(
        'Binary documents (e.g. PDF) are not supported by the Antigravity ACP runtime; send plain-text document sources only',
      );
    }
    if (sourceType === "url") {
      throw invalidRequest(
        "URL document sources are not supported by the Antigravity ACP runtime; send plain-text document sources only",
      );
    }
    throw invalidRequest(
      `Unsupported document source type "${String(sourceType)}"; only "text" is supported`,
    );
  }

  if (typeof source === "string") {
    return { type: "text", text: source };
  }
  if (typeof block.text === "string") {
    return { type: "text", text: block.text };
  }

  throw invalidRequest(
    'document blocks must carry a plain-text source ({ "type": "text", "data": "..." })',
  );
}

function parseToolUsePart(block: Record<string, unknown>): NormalizedContentPart {
  const id = nonEmptyString(block.id);
  if (id === null) {
    throw invalidRequest('tool_use blocks must include a non-empty "id"');
  }
  const name = nonEmptyString(block.name);
  if (name === null) {
    throw invalidRequest(`tool_use block "${id}" must include a non-empty "name"`);
  }
  return {
    type: "tool_use",
    id,
    name,
    input: isPlainObject(block.input) ? block.input : {},
  };
}

function parseToolResultPart(block: Record<string, unknown>): NormalizedContentPart {
  const toolUseId = nonEmptyString(block.tool_use_id);
  if (toolUseId === null) {
    throw invalidRequest('tool_result blocks must include a non-empty "tool_use_id"');
  }

  const content: ToolResultContentPart[] = [];
  const rawContent = block.content;

  if (typeof rawContent === "string") {
    content.push({ type: "text", text: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const inner of rawContent) {
      if (typeof inner === "string") {
        content.push({ type: "text", text: inner });
        continue;
      }
      if (!isPlainObject(inner)) {
        throw invalidRequest(
          `tool_result "${toolUseId}" content blocks must be objects or strings`,
        );
      }
      const innerType = inner.type;
      if (innerType === "text") {
        content.push({
          type: "text",
          text: typeof inner.text === "string" ? inner.text : "",
        });
      } else if (innerType === "image") {
        // Tool-result images go through the exact same strict base64 check.
        const image = parseImageSource(inner.source, `tool_result "${toolUseId}"`);
        content.push({ type: "image", mediaType: image.mediaType, data: image.data });
      } else if (innerType === "document") {
        const document = parseDocumentPart(inner);
        if (document.type !== "text") {
          throw invalidRequest(
            `tool_result "${toolUseId}": only plain-text documents are supported`,
          );
        }
        content.push(document);
      } else if (typeof innerType === "string" && RICH_BLOCK_TYPES.has(innerType)) {
        // `ToolSearch` references and server-tool results are text-only here.
        const rich = parseRichTextBlock(inner, innerType);
        if (rich !== null) content.push(rich);
      } else {
        throw invalidRequest(
          `Unsupported tool_result content block type "${String(innerType)}"`,
        );
      }
    }
  } else if (rawContent !== undefined && rawContent !== null) {
    throw invalidRequest(
      `tool_result "${toolUseId}" content must be a string or an array of content blocks`,
    );
  }

  return {
    type: "tool_result",
    toolUseId,
    isError: Boolean(block.is_error),
    content,
  };
}

function parseContentParts(
  content: unknown,
  role: "user" | "assistant",
  messageIndex: number,
): NormalizedContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    throw invalidRequest(
      `messages[${messageIndex}].content must be a string or an array of content blocks`,
    );
  }

  const parts: NormalizedContentPart[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
      continue;
    }
    if (!isPlainObject(block)) {
      throw invalidRequest(`messages[${messageIndex}] content blocks must be objects`);
    }

    const type = block.type;
    switch (type) {
      case "text":
        parts.push({
          type: "text",
          text: typeof block.text === "string" ? block.text : "",
        });
        break;
      case "image": {
        const image = parseImageSource(block.source, `messages[${messageIndex}]`);
        parts.push({ type: "image", mediaType: image.mediaType, data: image.data });
        break;
      }
      case "document":
        parts.push(parseDocumentPart(block));
        break;
      case "thinking": {
        const thinking = typeof block.thinking === "string" ? block.thinking : "";
        const signature = nonEmptyString(block.signature);
        parts.push(
          signature === null
            ? { type: "thinking", thinking }
            : { type: "thinking", thinking, signature },
        );
        break;
      }
      case "redacted_thinking":
        // Redacted blocks are opaque by design; they carry no replayable content.
        break;
      case "tool_use":
        if (role !== "assistant") {
          throw invalidRequest(
            `messages[${messageIndex}]: tool_use blocks are only valid in assistant messages`,
          );
        }
        parts.push(parseToolUsePart(block));
        break;
      case "tool_result":
        if (role !== "user") {
          throw invalidRequest(
            `messages[${messageIndex}]: tool_result blocks are only valid in user messages`,
          );
        }
        parts.push(parseToolResultPart(block));
        break;
      default:
        if (typeof type === "string" && RICH_BLOCK_TYPES.has(type)) {
          const rich = parseRichTextBlock(block, type);
          if (rich !== null) parts.push(rich);
          break;
        }
        throw invalidRequest(
          `Unsupported content block type "${String(type)}" in messages[${messageIndex}]`,
        );
    }
  }
  return parts;
}

function parseTools(tools: unknown): NormalizedTool[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) {
    throw invalidRequest("tools must be an array");
  }

  const parsed: NormalizedTool[] = [];
  for (let index = 0; index < tools.length; index += 1) {
    const raw = tools[index];
    if (!isPlainObject(raw)) {
      throw invalidRequest(`tools[${index}] must be an object`);
    }

    const name = nonEmptyString(raw.name);
    const declaredType = typeof raw.type === "string" ? raw.type : undefined;
    const isServerTool = declaredType !== undefined && declaredType !== "custom";
    const inputSchema = isPlainObject(raw.input_schema)
      ? raw.input_schema
      : isPlainObject(raw.parameters)
        ? raw.parameters
        : undefined;

    if (name === null) {
      if (isServerTool) {
        throw invalidRequest(
          `Server tool "${declaredType}" is not supported by the Antigravity ACP runtime; declare a custom tool with a name and input_schema`,
        );
      }
      throw invalidRequest(`tools[${index}] must include a non-empty "name"`);
    }

    if (inputSchema === undefined && isServerTool) {
      throw invalidRequest(
        `Server tool "${declaredType}" ("${name}") is not supported by the Antigravity ACP runtime; custom tools require an input_schema`,
      );
    }

    parsed.push({
      name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      inputSchema: inputSchema ?? emptyObjectSchema(),
    });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Request parsing: entry point
// ---------------------------------------------------------------------------

export function parseAnthropicRequest(
  rawBody: string | Uint8Array | null | undefined,
  headers: Headers,
  options: ProviderOptionsState,
): NormalizedAnthropicRequest {
  const body = decodeJsonBody(rawBody);

  const headerValue = (name: string): string | null =>
    typeof headers?.get === "function" ? headers.get(name) : null;

  const { model, effort: modelEffort } = parseModelAndEffort(body.model);

  const outputConfig = isPlainObject(body.output_config) ? body.output_config : undefined;
  // Precedence: inline model suffix > output_config.effort > reasoning_effort
  // > the x-magpie-effort header > the thinking.budget_tokens heuristic.
  const explicitEffort =
    modelEffort ??
    parseEffortLevel(outputConfig?.effort, "output_config.effort") ??
    parseEffortLevel(body.reasoning_effort, "reasoning_effort") ??
    parseEffortLevel(headerValue(EFFORT_HEADER), EFFORT_HEADER);

  // Streaming honesty: only an explicit `stream: true` produces SSE.
  const rawStream = body.stream;
  if (rawStream !== undefined && typeof rawStream !== "boolean") {
    throw invalidRequest("stream must be a boolean");
  }
  const stream = rawStream === true;

  if (
    body.stop_sequences !== undefined &&
    body.stop_sequences !== null &&
    !Array.isArray(body.stop_sequences)
  ) {
    throw invalidRequest("stop_sequences must be an array of strings");
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    throw new BridgeHttpError(
      400,
      "invalid_request_error",
      "stop_sequences are not supported by the Antigravity ACP runtime",
    );
  }

  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice, tools);

  const thinking = isPlainObject(body.thinking) ? body.thinking : undefined;
  const thinkingType =
    typeof thinking?.type === "string" ? thinking.type.toLowerCase() : undefined;
  const thinkingEnabled =
    thinkingType === "disabled" ? false : options.exposeThinking === true;

  const effortOverride = explicitEffort ?? effortFromThinkingBudget(thinking?.budget_tokens);

  // System prompt: top-level `system` plus any leading system-role messages.
  const systemSegments: string[] = [];
  const leadingSystem = extractSystemPrompt(body.system);
  if (leadingSystem.trim() !== "") systemSegments.push(leadingSystem);

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw invalidRequest("messages must be a non-empty array");
  }

  let cursor = 0;
  while (cursor < rawMessages.length) {
    const raw = rawMessages[cursor];
    if (!isPlainObject(raw)) {
      throw invalidRequest(`messages[${cursor}] must be an object`);
    }
    if (raw.role !== "system" && raw.role !== "developer") break;
    const systemText = extractSystemTextFromMessage(raw.content, cursor);
    if (systemText.trim() !== "") systemSegments.push(systemText);
    cursor += 1;
  }

  const messages: NormalizedAnthropicRequest["messages"] = [];
  for (; cursor < rawMessages.length; cursor += 1) {
    const raw = rawMessages[cursor];
    if (!isPlainObject(raw)) {
      throw invalidRequest(`messages[${cursor}] must be an object`);
    }

    let role: "user" | "assistant";
    let parts: NormalizedContentPart[];
    if (raw.role === "system" || raw.role === "developer") {
      // Mid-conversation hook notice / workdir update / queued user message:
      // ACP has one `user` role, so this must become a user turn, never a 400.
      const converted = convertMidConversationSystemMessage(raw.content, cursor);
      if (converted === null) continue;
      role = "user";
      parts = [converted];
    } else {
      if (raw.role !== "user" && raw.role !== "assistant") {
        throw invalidRequest(
          `Unsupported message role "${String(raw.role)}" at messages[${cursor}]; expected "user" or "assistant"`,
        );
      }
      role = raw.role;
      parts = parseContentParts(raw.content, role, cursor);
    }

    // Translators sometimes emit consecutive same-role messages; merge them so
    // the ACP prompt keeps one user/assistant turn per role run.
    const previous = messages[messages.length - 1];
    if (previous !== undefined && previous.role === role) {
      previous.content.push(...parts);
    } else {
      messages.push({ role, content: parts });
    }
  }

  if (messages.length === 0) {
    throw invalidRequest("messages must contain at least one user or assistant message");
  }

  const sessionIdHeader = headerValue(SESSION_ID_HEADER);
  const sessionId = sessionIdHeader === null ? null : nonEmptyString(sessionIdHeader);

  // Subagent / workdir are Claude Code tool-loop context: forwarded, never required.
  const subagentId =
    nonEmptyString(headerValue(SUBAGENT_HEADER)) ??
    nonEmptyString(headerValue(ALT_SUBAGENT_HEADER));
  const workDir = nonEmptyString(headerValue(WORKDIR_HEADER));

  const metadata = isPlainObject(body.metadata) ? body.metadata : undefined;
  const userId = typeof metadata?.user_id === "string" ? metadata.user_id : undefined;

  const maxTokens =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.max(0, Math.trunc(body.max_tokens))
      : undefined;

  return {
    model,
    ...(effortOverride === undefined ? {} : { effortOverride }),
    system: systemSegments.join("\n\n"),
    messages,
    tools,
    toolChoice,
    stream,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    thinkingEnabled,
    sessionId,
    ...(subagentId === null ? {} : { subagentId }),
    ...(workDir === null ? {} : { workDir }),
    ...(userId === undefined ? {} : { userId }),
  };
}

// ---------------------------------------------------------------------------
// Synthetic thinking signatures
// ---------------------------------------------------------------------------

/**
 * Per-process HMAC key. Signatures are only ever verified by this process
 * (they exist so clients that require a non-empty `signature` on `thinking`
 * blocks accept streamed thought summaries), so the key never leaves memory.
 */
const PER_PROCESS_KEY = randomBytes(32);

export function createSyntheticThinkingSignature(
  sessionId: string,
  thinkingText: string,
): string {
  const digest = createHmac("sha256", PER_PROCESS_KEY)
    .update(`${sessionId}:${thinkingText}`)
    .digest("base64url");
  return `agy1.${digest}`;
}

// ---------------------------------------------------------------------------
// Error encoding
// ---------------------------------------------------------------------------

export function jsonErrorResponse(err: unknown): Response {
  const bridge = err instanceof BridgeHttpError ? err : null;

  const status =
    bridge !== null &&
    Number.isInteger(bridge.status) &&
    bridge.status >= 400 &&
    bridge.status <= 599
      ? bridge.status
      : 502;

  const errorType = bridge?.errorType ?? "api_error";
  const message =
    bridge !== null
      ? bridge.message
      : err instanceof Error && err.message.trim() !== ""
        ? err.message
        : "Unexpected internal error";

  // Magpie's gateway reads this header to mark the account's sign-in expired
  // immediately, instead of retrying a credential that will never work again.
  const signInExpired = bridge !== null && (bridge.signInExpired || bridge.status === 401);
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (signInExpired) headers[SIGN_IN_HEADER] = "expired";

  return new Response(
    JSON.stringify({ type: "error", error: { type: errorType, message } }),
    { status, headers },
  );
}

// ---------------------------------------------------------------------------
// SSE encoding
// ---------------------------------------------------------------------------

type PeekOutcome = { kind: "error"; error: unknown } | { kind: "events" };

/** Maps one terminal `error` event onto the bridge error it represents. */
function bridgeErrorFromEvent(
  event: Extract<TurnStreamEvent, { type: "error" }>,
): BridgeHttpError {
  return new BridgeHttpError(event.status, event.errorType, event.message, {
    signInExpired: event.signInExpired,
  });
}

/**
 * The events that mean "the turn has begun": once one of these arrives we must
 * answer `200` and switch to SSE, because content has already been produced.
 * `thinking_signature` deliberately does not count: it is buffered so a
 * signature-only stream still becomes a single clean message.
 */
const PRE_STREAM_TERMINATOR_TYPES: ReadonlySet<TurnStreamEvent["type"]> = new Set([
  "text_delta",
  "thinking_delta",
  "tool_use",
  "finish",
]);

/**
 * Pulls events from the runtime until the turn is provably started (or failed).
 *
 * This is what lets a `stream: true` request still answer with a real HTTP
 * `400`/`409`/`429`/`503` when the pool is exhausted or the request is invalid:
 * the first iterator steps happen *before* the response status is committed.
 */
class PeekedTurnSource {
  readonly iterator: AsyncIterator<TurnStreamEvent>;
  readonly peeked: TurnStreamEvent[] = [];
  readonly ready: Promise<PeekOutcome>;
  private claimed = false;
  private closed = false;
  private drainedAfterFinish = false;
  private drainTimedOut = false;

  constructor(events: AsyncIterable<TurnStreamEvent>, signal?: AbortSignal) {
    this.iterator = events[Symbol.asyncIterator]();
    this.ready = this.peek(signal);
  }

  /** Exactly one response body may drive the iterator. */
  claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }

  /**
   * Steps the upstream one more time after `finish` so a generator that commits
   * its ledger *after* `yield finish` (the session coordinator does) can run to
   * natural completion instead of being unwound from inside the yield by
   * `iterator.return()`. Bounded so a misbehaving upstream cannot hang teardown.
   */
  async drainAfterFinish(): Promise<void> {
    if (this.closed || this.drainedAfterFinish) return;
    this.drainedAfterFinish = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const winner = await Promise.race([
        this.iterator.next().then(() => "stepped" as const),
        new Promise<"timed_out">((resolve) => {
          timer = setTimeout(() => resolve("timed_out"), FINISH_DRAIN_GUARD_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (winner === "timed_out") this.drainTimedOut = true;
    } catch {
      // A generator that throws past `finish` has already ended; close() finishes.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Releases the upstream turn exactly once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const pending = this.iterator.return?.();
      // If the drain guard fired, a `next()` is still outstanding and a queued
      // `return()` would only settle when it does: never block teardown on it.
      if (this.drainTimedOut) {
        void Promise.resolve(pending).catch(() => {});
        return;
      }
      await pending;
    } catch {
      // Upstream teardown failures are not actionable for the caller.
    }
  }

  private async peek(signal?: AbortSignal): Promise<PeekOutcome> {
    try {
      for (;;) {
        if (signal?.aborted === true) return { kind: "events" };
        const result = await this.iterator.next();
        if (result.done === true) return { kind: "events" };
        const event = result.value;
        if (event.type === "error") {
          // Pre-stream failure: surface the real status, not a 200 SSE stream.
          return { kind: "error", error: bridgeErrorFromEvent(event) };
        }
        this.peeked.push(event);
        if (PRE_STREAM_TERMINATOR_TYPES.has(event.type)) return { kind: "events" };
      }
    } catch (error) {
      return { kind: "error", error };
    }
  }
}

interface SseChannel {
  readonly isClosed: boolean;
  bind(controller: ReadableStreamDefaultController<Uint8Array>): void;
  bindAbort(signal: AbortSignal | undefined, onAbort: () => void): void;
  emit(event: string, data: unknown): Promise<void>;
  /** Grants one frame of downstream capacity and wakes a blocked `emit`. */
  wakeDrain(): void;
  startHeartbeat(intervalMs: number): void;
  finish(): void;
}

function createSseChannel(): SseChannel {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let detachAbort: (() => void) | null = null;
  /**
   * Downstream credits, one per `pull()`. With `highWaterMark: 0` a consumer
   * that keeps reading never lets `desiredSize` rise above 0, so a pull is the
   * only reliable signal that the buffer really drained.
   */
  let pullCredits = 0;
  /** Resolver parked by `emit` while the downstream buffer is full. */
  let drainWaiter: (() => void) | null = null;

  const resolveDrainWaiter = (): void => {
    const waiter = drainWaiter;
    drainWaiter = null;
    waiter?.();
  };

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const encodeFrame = (event: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  /**
   * Unconditional write, used by heartbeats. It still consumes a pull credit so
   * pings and pump frames share the same downstream budget.
   */
  const writeFrame = (event: string, data: unknown): void => {
    if (closed || controller === null) return;
    if (pullCredits > 0) pullCredits -= 1;
    try {
      controller.enqueue(encodeFrame(event, data));
    } catch {
      closed = true;
    }
  };

  const finish = (): void => {
    if (closed) return;
    // Before the stream is bound there is nothing to close yet; pull() finishes.
    if (controller === null) return;
    closed = true;
    stopHeartbeat();
    if (detachAbort !== null) {
      detachAbort();
      detachAbort = null;
    }
    // A pump parked on backpressure must never be left hanging on teardown.
    resolveDrainWaiter();
    try {
      controller.close();
    } catch {
      // Already closed by the consumer.
    }
  };

  return {
    get isClosed(): boolean {
      return closed;
    },
    bind(next: ReadableStreamDefaultController<Uint8Array>): void {
      controller = next;
    },
    /**
     * Wires abort handling lazily. Only a body that actually claimed the turn
     * calls this, so an unconsumed placeholder Response registers no listener
     * (and can never cancel the source owned by the live body).
     */
    bindAbort(signal: AbortSignal | undefined, onAbort: () => void): void {
      if (signal === undefined || detachAbort !== null || closed) return;
      if (signal.aborted) {
        // Dead before pumping (the caller hung up while we peeked).
        finish();
        onAbort();
        return;
      }
      const onAbortEvent = (): void => {
        finish();
        onAbort();
      };
      signal.addEventListener("abort", onAbortEvent, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbortEvent);
    },
    async emit(event: string, data: unknown): Promise<void> {
      // Bound the buffer: a reader that stops reading must stall the pump here
      // (memory would otherwise grow without limit), and a cancelled stream
      // wakes us through `finish()` so the `await` never hangs.
      for (;;) {
        if (closed || controller === null) return;
        // A null desiredSize means the downstream is already closed or errored:
        // there is nothing left worth writing to.
        const desired = controller.desiredSize;
        if (desired === null) return;
        if (pullCredits > 0 || desired > 0) {
          writeFrame(event, data);
          return;
        }
        await new Promise<void>((resolve) => {
          drainWaiter = resolve;
        });
      }
    },
    wakeDrain(): void {
      pullCredits += 1;
      resolveDrainWaiter();
    },
    startHeartbeat(intervalMs: number): void {
      if (heartbeat !== null || closed) return;
      const timer = setInterval(() => {
        if (closed) return;
        writeFrame("ping", { type: "ping" });
      }, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      heartbeat = timer;
    },
    finish,
  };
}

interface OpenSseBlock {
  kind: "thinking" | "text";
  index: number;
  thinking: string;
  signatureSent: boolean;
}

interface SseTurnState {
  nextIndex: number;
  openBlock: OpenSseBlock | null;
  pendingSignature: string | null;
  thinkingBlocksEmitted: number;
}

function bridgeErrorFromUnknown(err: unknown): BridgeHttpError {
  if (err instanceof BridgeHttpError) return err;
  if (err instanceof Error && err.message.trim() !== "") {
    return new BridgeHttpError(502, "api_error", err.message);
  }
  return new BridgeHttpError(502, "api_error", "Unexpected upstream failure");
}

async function emitStreamErrorFrame(channel: SseChannel, err: unknown): Promise<void> {
  const bridge = bridgeErrorFromUnknown(err);
  // Once the status line is gone we can only report the error inside the stream.
  await channel.emit("error", {
    type: "error",
    error: { type: bridge.errorType, message: bridge.message },
  });
}

async function openThinkingBlock(state: SseTurnState, channel: SseChannel): Promise<void> {
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.thinkingBlocksEmitted += 1;
  state.openBlock = { kind: "thinking", index, thinking: "", signatureSent: false };
  await channel.emit("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "" },
  });
}

async function openTextBlock(state: SseTurnState, channel: SseChannel): Promise<void> {
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.openBlock = { kind: "text", index, thinking: "", signatureSent: false };
  await channel.emit("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

async function closeOpenBlock(state: SseTurnState, channel: SseChannel): Promise<void> {
  const block = state.openBlock;
  if (block === null) return;
  state.openBlock = null;

  if (block.kind === "thinking" && !block.signatureSent) {
    // Clients require a non-empty signature on thinking blocks.
    const signature =
      state.pendingSignature ?? createSyntheticThinkingSignature("", block.thinking);
    state.pendingSignature = null;
    await channel.emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "signature_delta", signature },
    });
  }
  await channel.emit("content_block_stop", { type: "content_block_stop", index: block.index });
}

async function emitCompletion(
  channel: SseChannel,
  stopReason: string,
  usage: TokenUsageSummary | undefined,
): Promise<void> {
  await channel.emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usagePayload(usage),
  });
  await channel.emit("message_stop", { type: "message_stop" });
}

/** Encodes one turn event. Returns `true` when the stream is finished. */
async function encodeSseEvent(
  event: TurnStreamEvent,
  state: SseTurnState,
  channel: SseChannel,
): Promise<boolean> {
  switch (event.type) {
    case "thinking_delta": {
      if (state.openBlock?.kind !== "thinking") {
        await closeOpenBlock(state, channel);
        await openThinkingBlock(state, channel);
      }
      const block = state.openBlock;
      if (block === null) return true;
      block.thinking += event.thinking;
      await channel.emit("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "thinking_delta", thinking: event.thinking },
      });
      return false;
    }
    case "thinking_signature": {
      if (state.openBlock?.kind === "thinking") {
        state.openBlock.signatureSent = true;
        state.pendingSignature = null;
        await channel.emit("content_block_delta", {
          type: "content_block_delta",
          index: state.openBlock.index,
          delta: { type: "signature_delta", signature: event.signature },
        });
      } else if (state.thinkingBlocksEmitted === 0) {
        // Signature ahead of its thought block (e.g. a signature-only turn).
        state.pendingSignature = event.signature;
      }
      // A late signature for an already-closed block cannot be retro-fitted; the
      // block was closed with its own signature, so dropping it is honest.
      return false;
    }
    case "text_delta": {
      if (state.openBlock?.kind !== "text") {
        await closeOpenBlock(state, channel);
        await openTextBlock(state, channel);
      }
      const block = state.openBlock;
      if (block === null) return true;
      await channel.emit("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "text_delta", text: event.text },
      });
      return false;
    }
    case "tool_use": {
      await closeOpenBlock(state, channel);
      const index = state.nextIndex;
      state.nextIndex += 1;
      await channel.emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
      });
      await channel.emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(event.input ?? {}),
        },
      });
      await channel.emit("content_block_stop", { type: "content_block_stop", index });
      return false;
    }
    case "finish": {
      await closeOpenBlock(state, channel);
      await emitCompletion(channel, event.stopReason, event.usage);
      return true;
    }
    case "error": {
      await emitStreamErrorFrame(channel, bridgeErrorFromEvent(event));
      return true;
    }
    default:
      return false;
  }
}

async function pumpTurnEvents(
  model: string,
  source: PeekedTurnSource,
  channel: SseChannel,
  signal: AbortSignal | undefined,
): Promise<void> {
  const state: SseTurnState = {
    nextIndex: 0,
    openBlock: null,
    pendingSignature: null,
    thinkingBlocksEmitted: 0,
  };

  try {
    await channel.emit("message_start", {
      type: "message_start",
      message: {
        id: createMessageId(),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usagePayload(undefined),
      },
    });
    channel.startHeartbeat(PING_INTERVAL_MS);

    const outcome = await source.ready;
    if (outcome.kind === "error") {
      await emitStreamErrorFrame(channel, outcome.error);
      return;
    }

    for (const event of source.peeked) {
      if (channel.isClosed) return;
      if (await encodeSseEvent(event, state, channel)) {
        if (event.type === "finish") await source.drainAfterFinish();
        return;
      }
    }

    while (!channel.isClosed && signal?.aborted !== true) {
      let result: IteratorResult<TurnStreamEvent>;
      try {
        result = await source.iterator.next();
      } catch (err) {
        await emitStreamErrorFrame(channel, err);
        return;
      }
      if (result.done === true) break;
      if (await encodeSseEvent(result.value, state, channel)) {
        // Let the upstream generator run past `yield finish` to natural
        // completion (the coordinator commits its ledger there) before teardown.
        if (result.value.type === "finish") await source.drainAfterFinish();
        return;
      }
    }

    if (channel.isClosed || signal?.aborted === true) return;
    // Upstream stopped yielding without a finish event: end the message cleanly.
    await closeOpenBlock(state, channel);
    await emitCompletion(channel, "end_turn", undefined);
  } catch (err) {
    // Post-200 failures can only be reported as an in-stream error frame.
    try {
      await emitStreamErrorFrame(channel, err);
    } catch {
      // Nothing left to tell the caller.
    }
  } finally {
    channel.finish();
    // Release the upstream turn: stopping mid-iteration would otherwise leave a
    // coordinator generator suspended at a `yield` (and its session lock held).
    await source.close();
  }
}

function createSseResponse(
  model: string,
  source: PeekedTurnSource,
  signal: AbortSignal | undefined,
): Response {
  const channel = createSseChannel();
  let pumping = false;
  let ownsSource = false;

  // Only a body that claimed the turn may release it: an unclaimed twin must
  // never cancel a source another body is driving.
  const releaseSource = (): void => {
    if (!ownsSource) return;
    void source.close();
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        channel.bind(controller);
      },
      pull() {
        // A pull is the only proof that the downstream buffer really drained.
        channel.wakeDrain();
        if (pumping) return;
        pumping = true;
        if (!source.claim()) {
          // Another body already drives this turn (the placeholder twin).
          channel.finish();
          return;
        }
        ownsSource = true;
        // Abort wiring happens here, after the claim: an unconsumed placeholder
        // Response therefore registers zero AbortSignal listeners.
        channel.bindAbort(signal, releaseSource);
        if (channel.isClosed || signal?.aborted === true) {
          releaseSource();
          return;
        }
        void pumpTurnEvents(model, source, channel, signal).catch(() => channel.finish());
      },
      cancel() {
        channel.finish();
        releaseSource();
      },
    },
    // High-water mark 0 keeps the pump lazy: an unused Response (e.g. the
    // placeholder below) never consumes the upstream iterator.
    { highWaterMark: 0 },
  );

  return new Response(body, { status: 200, headers: { ...SSE_HEADERS } });
}

type ResponseThen = (
  onFulfilled?: ((value: Response) => unknown) | null,
  onRejected?: ((reason: unknown) => unknown) | null,
) => Promise<unknown>;

/**
 * Makes an already-usable `Response` also awaitable, resolving to the finalized
 * response (which carries the real status for pre-stream failures).
 *
 * Both usage styles are supported:
 *   const res = await encodeAnthropicSseResponse(...); // exact status
 *   const res = encodeAnthropicSseResponse(...);       // 200 SSE immediately
 */
function asAwaitableResponse(response: Response, finalized: Promise<Response>): Response {
  try {
    Object.defineProperty(response, "then", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: ((onFulfilled, onRejected) => finalized.then(onFulfilled, onRejected)) as ResponseThen,
    });
  } catch {
    // A non-extensible Response still streams correctly, it just cannot be awaited.
  }
  return response;
}

export function encodeAnthropicSseResponse(
  model: string,
  events: AsyncIterable<TurnStreamEvent>,
  signal?: AbortSignal,
): Response {
  let source: PeekedTurnSource;
  try {
    source = new PeekedTurnSource(events, signal);
  } catch (err) {
    return jsonErrorResponse(err);
  }

  const finalized = source.ready
    .then(async (outcome) => {
      if (outcome.kind === "error") {
        // Release the upstream turn before answering with a real HTTP error:
        // a coordinator generator suspended at its `yield` would otherwise hold
        // its session lock forever (`encodeAnthropicSseResponse` is awaited by
        // every caller, so nobody else will ever pull the stream).
        await source.close();
        return jsonErrorResponse(outcome.error);
      }
      return createSseResponse(model, source, signal);
    })
    .catch(async (err: unknown) => {
      await source.close();
      return jsonErrorResponse(err);
    });

  return asAwaitableResponse(createSseResponse(model, source, signal), finalized);
}

// ---------------------------------------------------------------------------
// Non-streaming JSON encoding
// ---------------------------------------------------------------------------

type JsonContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export async function collectAnthropicJsonResponse(
  model: string,
  events: AsyncIterable<TurnStreamEvent>,
  signal?: AbortSignal,
): Promise<Response> {
  const content: JsonContentBlock[] = [];
  let stopReason = "end_turn";
  let usage: TokenUsageSummary = ZERO_USAGE;
  type ThinkingBlock = { type: "thinking"; thinking: string; signature: string };
  // `openThinking` accepts further deltas; `lastThinking` also survives text and
  // tool blocks so a signature emitted at end-of-turn still lands on its block.
  let openThinking: ThinkingBlock | null = null;
  let lastThinking: ThinkingBlock | null = null;

  try {
    for await (const event of events) {
      if (signal?.aborted === true) break;

      switch (event.type) {
        case "text_delta": {
          const last = content[content.length - 1];
          if (last !== undefined && last.type === "text") {
            last.text += event.text;
          } else {
            content.push({ type: "text", text: event.text });
          }
          openThinking = null;
          break;
        }
        case "thinking_delta": {
          if (openThinking !== null) {
            openThinking.thinking += event.thinking;
          } else {
            const block: ThinkingBlock = { type: "thinking", thinking: event.thinking, signature: "" };
            content.push(block);
            openThinking = block;
            lastThinking = block;
          }
          break;
        }
        case "thinking_signature": {
          if (openThinking !== null) {
            openThinking.signature = event.signature;
          } else if (lastThinking !== null) {
            // The runtime emits the signature at the end of the turn, possibly
            // after the text block; it still belongs to the last thought block.
            lastThinking.signature = event.signature;
          } else {
            const block: ThinkingBlock = {
              type: "thinking",
              thinking: "",
              signature: event.signature,
            };
            content.push(block);
            openThinking = block;
            lastThinking = block;
          }
          break;
        }
        case "tool_use": {
          content.push({
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: event.input ?? {},
          });
          openThinking = null;
          break;
        }
        case "finish": {
          stopReason = event.stopReason;
          usage = event.usage ?? ZERO_USAGE;
          break;
        }
        case "error": {
          return jsonErrorResponse(bridgeErrorFromEvent(event));
        }
        default:
          break;
      }
    }
  } catch (err) {
    return jsonErrorResponse(err);
  }

  for (const block of content) {
    if (block.type === "thinking" && block.signature === "") {
      block.signature = createSyntheticThinkingSignature("", block.thinking);
    }
  }

  if (content.length === 0 && stopReason === "end_turn") {
    content.push({ type: "text", text: "" });
  }

  const message = {
    id: createMessageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usagePayload(usage),
  };

  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { ...JSON_HEADERS },
  });
}
