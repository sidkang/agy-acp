export type AccountMode = "host" | "isolated";

export interface AccountDescriptor {
  /** Magpie slot key, e.g. "agy-acp" or "agy-acp#abc123" */
  readonly slotKey: string;
  /** Immutable internal reference: "host" or validated UUID v4 */
  readonly accountRef: string;
  readonly mode: AccountMode;
  /** Display label only, never used as storage path or dedup authority */
  readonly label: string;
  /** Resolved isolated home directory when mode === "isolated"; null for "host" */
  readonly isolatedHomeDir: string | null;
}

export interface PersistedAuthMetadata {
  schemaVersion: 1;
  accountRef: string;
  mode: AccountMode;
  email?: string;
  label?: string;
}

export interface ProviderOptionsState {
  quotaRouting: boolean;
  minimalAgent: boolean;
  exposeThinking: boolean;
  cloakPrompts: boolean;
}

export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OfferedModelVariant {
  /** Underlying agy model ID (e.g. "gemini-3.8-flash-low" or "gemini-pro-orchestrator") */
  readonly rawModelId: string;
  /** Base family ID exposed to Magpie (e.g. "gemini-3.8-flash") */
  readonly familyId: string;
  readonly displayName: string;
  /** ACP configOption model value (e.g. "gemini-3.8-flash") */
  readonly configModelValue: string;
  /** Optional thought_level value if variant corresponds to an effort level */
  readonly effort?: EffortLevel;
}

export interface NormalizedToolDef {
  /** Original tool name declared by caller */
  readonly originalName: string;
  /** Sanitized MCP-safe name ([A-Za-z0-9_-]{1,64}) */
  readonly mcpName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type ToolChoiceSpec =
  | { type: "auto"; disableParallelToolUse?: boolean }
  | { type: "any"; disableParallelToolUse?: boolean }
  | { type: "none" }
  | { type: "tool"; name: string; disableParallelToolUse?: boolean };

export type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      isError: boolean;
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }
      >;
    };

export interface NormalizedMessage {
  role: "user" | "assistant";
  content: NormalizedContentPart[];
}

export interface NormalizedAnthropicRequest {
  model: string;
  effortOverride?: EffortLevel;
  system: string;
  messages: NormalizedMessage[];
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  toolChoice: ToolChoiceSpec;
  stream: boolean;
  maxTokens?: number;
  thinkingEnabled: boolean;
  sessionId: string | null;
  subagentId?: string;
  workDir?: string;
  userId?: string;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type TurnStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal";

export type TurnStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_signature"; signature: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "finish";
      stopReason: TurnStopReason;
      usage: TokenUsageSummary;
    }
  | {
      type: "error";
      status: number;
      errorType:
        | "invalid_request_error"
        | "authentication_error"
        | "permission_error"
        | "rate_limit_error"
        | "overloaded_error"
        | "api_error";
      message: string;
      signInExpired?: boolean;
    };

export class BridgeHttpError extends Error {
  readonly status: number;
  readonly errorType:
    | "invalid_request_error"
    | "authentication_error"
    | "permission_error"
    | "rate_limit_error"
    | "overloaded_error"
    | "api_error";
  readonly signInExpired: boolean;

  constructor(
    status: number,
    errorType: BridgeHttpError["errorType"],
    message: string,
    opts?: { signInExpired?: boolean },
  ) {
    super(message);
    this.name = "BridgeHttpError";
    this.status = status;
    this.errorType = errorType;
    this.signInExpired = Boolean(
      opts?.signInExpired || (status === 401 && errorType === "authentication_error"),
    );
  }
}
