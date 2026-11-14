// Per-session MCP tool broker.
//
// One `AgySessionWorker` owns one `SessionToolBroker`. The broker advertises the
// caller's Anthropic tools as `mcp_magpie_<mcpName>` to `agy`, and turns every
// `tools/call` JSON-RPC request into a parked promise. The HTTP `POST /mcp/:token`
// that carried the call stays open (MCP Streamable HTTP, stateless POST) until the
// caller delivers the matching `tool_result` on a later bridge HTTP turn.
//
// Calls are exposed to the caller as authentic `toolu_...` IDs: no fake
// "still running" completion and no argument-equality deduplication, so two
// parallel calls with identical arguments stay two distinct tool uses.

import { randomBytes } from "node:crypto"

import { BridgeHttpError } from "../types"
import type { NormalizedAnthropicRequest, NormalizedToolDef, ToolChoiceSpec } from "../types"
import { fitInlineImage } from "../protocol/images"
import { normalizeToolDefinitions } from "./schema/sanitizer"

export interface ExposedToolCall {
  id: string // "toolu_" + 24 random hex chars
  name: string // original caller tool name
  mcpName: string
  input: Record<string, unknown>
}

export interface ToolResultDelivery {
  toolUseId: string
  isError: boolean
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mediaType: string; data: string }
  >
}

export interface DeliverToolResultsOutcome {
  allPendingResolved: boolean
  remainingExposedIds: string[]
  newlyExposedCalls: ExposedToolCall[]
}

export interface SessionToolBrokerOptions {
  batchWindowMs?: number
  callDeadlineMs?: number
  maxRejectedNoneCalls?: number
  onBatchReady?: (calls: ExposedToolCall[]) => void
  onFatalToolLoop?: (reason: string) => void
  onCallExpired?: (callId: string) => void
  /** Delay before a parked call answers "still running". 0 disables the relay. */
  relayAfterMs?: number
}

export interface JsonRpcResponse {
  status: number
  body: unknown | null
}

const DEFAULT_BATCH_WINDOW_MS = 30
const DEFAULT_CALL_DEADLINE_MS = 15 * 60 * 1000
const DEFAULT_MAX_REJECTED_NONE_CALLS = 3

const TOOL_USE_ID_PREFIX = "toolu_"
// `agy` abandons a `tools/call` at 180 s (measured on 1.5.9: the POST aborts at
// 180.004 s). A parked call answers with a "still running" notice well before that
// and lets the model ask for the result again, so the same tool execution keeps
// running instead of being turned into a timeout the model has to write around.
const RELAY_TOOL_NAME = "await_result"
const DEFAULT_RELAY_AFTER_MS = 150_000
const MAX_RELAY_WAITS = 20
const MAX_STRANDED_RESULTS = 32
const PROTOCOL_VERSION = "2024-11-05"
const SERVER_INFO = { name: "magpie-bridge", version: "0.1.0" } as const
const ALWAYS_LOAD_META = { "antigravity/alwaysLoad": true } as const

const TOOL_DISABLED_TEXT = "Tool calls are disabled for this turn (tool_choice=none). Respond directly in plain text."
const TOOL_LOOP_REASON = "Model repeatedly attempted tool calls while tool_choice is none"

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

interface McpCallToolResult {
  isError?: true
  content: McpContent[]
}

interface ParkedCall {
  id: string
  name: string
  mcpName: string
  input: Record<string, unknown>
  promise: Promise<unknown>
  resolve: (result: unknown) => void
  deadlineTimer: ReturnType<typeof setTimeout> | null
  /** "Still running" notices this call has answered with. */
  relayWaits: number
  /** MCP waits currently listening for this call's result. */
  waiters: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Tool arguments are always a JSON object for `agy`; anything else is wrapped. */
function ensureObject(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value
  if (value === undefined || value === null) return {}
  return { value }
}

function errorResult(text: string): McpCallToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}

const RELAY = Symbol("relay")
const ABORTED = Symbol("aborted")

export interface ToolCallContext {
  signal?: AbortSignal
}

/**
 * What the model is told when a parked call outlives the relay delay.
 *
 * Not an error: the execution is still running. It names the tool as `agy` shows
 * it (`mcp_magpie_await_result`), because that is the name the model must call.
 */
function relayNotice(call: ParkedCall): McpCallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `The bridge is still running tool call ${call.id} (${call.name}). ` +
          `Call mcp_magpie_${RELAY_TOOL_NAME} with {"call_id":"${call.id}"} to receive its result. ` +
          `Do not repeat the original call, and do not end the turn before the result arrives.`,
      },
    ],
  }
}

function createParkedCall(name: string, mcpName: string, input: Record<string, unknown>): ParkedCall {
  let resolveFn: (result: unknown) => void = () => {}
  const promise = new Promise<unknown>((resolve) => {
    resolveFn = resolve
  })
  return {
    id: `${TOOL_USE_ID_PREFIX}${randomBytes(12).toString("hex")}`,
    name,
    mcpName,
    input,
    promise,
    resolve: resolveFn,
    deadlineTimer: null,
    relayWaits: 0,
    waiters: 0,
  }
}

function toExposedCall(call: ParkedCall): ExposedToolCall {
  return { id: call.id, name: call.name, mcpName: call.mcpName, input: call.input }
}

function toMcpResult(delivery: ToolResultDelivery): McpCallToolResult {
  const content: McpContent[] = delivery.content.length
    ? delivery.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text }
      // A tool can return a screenshot straight from disk: an oversized image is
      // re-encoded the way Magpie's Claude bridge does, and one that already fits
      // (or cannot be read) comes back byte for byte.
      const fitted = fitInlineImage(part.mediaType, part.data)
      return { type: "image", data: fitted.data, mimeType: fitted.mediaType }
    })
    : [{ type: "text", text: "" }]
  const result: McpCallToolResult = { content }
  if (delivery.isError) result.isError = true
  return result
}

export class SessionToolBroker {
  private readonly batchWindowMs: number
  private readonly callDeadlineMs: number
  private readonly maxRejectedNoneCalls: number
  private readonly onBatchReady?: (calls: ExposedToolCall[]) => void
  private readonly onFatalToolLoop?: (reason: string) => void
  private readonly onCallExpired?: (callId: string) => void
  private readonly relayAfterMs: number

  private normalizedTools: NormalizedToolDef[] = []
  private mcpToOriginal = new Map<string, string>()
  private toolChoice: ToolChoiceSpec = { type: "auto" }
  private rejectedNoneCount = 0
  private rejectedChoiceCount = 0

  /** Calls the current HTTP turn is allowed to expose to the caller. */
  private currentBatch: ParkedCall[] = []
  /** Parked calls already announced to the caller via `stop_reason: "tool_use"`. */
  private exposedPending = new Map<string, ParkedCall>()
  /** Late parallel siblings that arrived after the previous HTTP turn closed. */
  private queuedUnexposed: ParkedCall[] = []

  /** Every call this turn parked, so `await_result` can find it again. */
  private callsById = new Map<string, ParkedCall>()
  /** The wait listening on each in-flight JSON-RPC request id. */
  private waitersById = new Map<string | number, AbortController>()
  /** Results that arrived after their wait was abandoned, for the next prompt. */
  private stranded: Array<{ callId: string; name: string; result: McpCallToolResult }> = []

  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private turnOutputOpen = true

  constructor(options: SessionToolBrokerOptions = {}) {
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.callDeadlineMs = options.callDeadlineMs ?? DEFAULT_CALL_DEADLINE_MS
    this.maxRejectedNoneCalls = options.maxRejectedNoneCalls ?? DEFAULT_MAX_REJECTED_NONE_CALLS
    this.onBatchReady = options.onBatchReady
    this.onFatalToolLoop = options.onFatalToolLoop
    this.onCallExpired = options.onCallExpired
    this.relayAfterMs = options.relayAfterMs ?? DEFAULT_RELAY_AFTER_MS
  }

  setTools(rawTools: NormalizedAnthropicRequest["tools"]): NormalizedToolDef[] {
    const normalized = normalizeToolDefinitions(rawTools)
    this.normalizedTools = normalized.tools
    this.mcpToOriginal = normalized.mcpToOriginal
    return this.normalizedTools
  }

  /**
   * `tool_choice: "none"` must not change `tools/list`: the full catalog stays
   * registered (with `alwaysLoad`) so `agy`'s upstream prompt cache and the
   * declared-tool surface stay identical between turns. Only `tools/call` is
   * rejected, without ever exposing a `tool_use` to the caller.
   */
  setToolChoice(choice: ToolChoiceSpec): void {
    this.rejectedNoneCount = 0
    this.rejectedChoiceCount = 0
    this.toolChoice = choice
  }

  getToolChoice(): ToolChoiceSpec {
    return this.toolChoice
  }

  /** Start a new HTTP turn in which `tools/call`s may be exposed. */
  openTurnWindow(): void {
    this.turnOutputOpen = true
  }

  /** The HTTP turn just closed (text or end arrived): flush and stop exposing. */
  markHttpTurnClosed(): void {
    this.turnOutputOpen = false
    this.flushBatch()
  }

  hasPendingWork(): boolean {
    return this.exposedPending.size > 0 || this.queuedUnexposed.length > 0 || this.currentBatch.length > 0
  }

  getExposedPendingIds(): string[] {
    return [...this.exposedPending.keys()]
  }

  deliverToolResults(results: ToolResultDelivery[]): DeliverToolResultsOutcome {
    const resolvedPayloads = new Map<string, string>()
    const accepted: ToolResultDelivery[] = []

    // Validate everything before mutating so a bad sibling cannot half-resolve.
    for (const result of results) {
      const payload = JSON.stringify({ isError: Boolean(result.isError), content: result.content })
      if (resolvedPayloads.has(result.toolUseId)) {
        // A retry may repeat the same result byte for byte; that is idempotent.
        // Only a conflicting payload for one id is an error.
        if (resolvedPayloads.get(result.toolUseId) !== payload) {
          throw new BridgeHttpError(409, "invalid_request_error", `Duplicate tool_result for ${result.toolUseId}`)
        }
        continue
      }
      if (!this.exposedPending.has(result.toolUseId)) {
        throw new BridgeHttpError(400, "invalid_request_error", `Unknown or unexposed tool_use_id: ${result.toolUseId}`)
      }
      resolvedPayloads.set(result.toolUseId, payload)
      accepted.push(result)
    }

    for (const delivery of accepted) {
      const call = this.exposedPending.get(delivery.toolUseId)
      if (!call) continue
      this.clearDeadline(call)
      this.exposedPending.delete(delivery.toolUseId)
      this.callsById.delete(delivery.toolUseId)
      const resolved = toMcpResult(delivery)
      // The model may have ended its turn instead of asking again: keep the
      // result for the next prompt rather than resolving into nobody.
      if (call.relayWaits > 0 && call.waiters === 0) {
        this.stranded.push({ callId: call.id, name: call.name, result: resolved })
        if (this.stranded.length > MAX_STRANDED_RESULTS) this.stranded.shift()
      }
      call.resolve(resolved)
    }

    if (this.exposedPending.size === 0 && this.queuedUnexposed.length > 0) {
      // With parallel tool use disabled the caller may only ever see one tool_use
      // per turn, so release a single late sibling and leave the rest parked for
      // the following round instead of exposing them together.
      const singleAtATime = this.disablesParallelToolUse()
      const late = singleAtATime ? [this.queuedUnexposed.shift()!] : this.queuedUnexposed
      if (!singleAtATime) this.queuedUnexposed = []
      for (const call of late) this.exposedPending.set(call.id, call)
      return {
        allPendingResolved: false,
        remainingExposedIds: [...this.exposedPending.keys()],
        newlyExposedCalls: late.map(toExposedCall),
      }
    }

    if (this.exposedPending.size > 0) {
      return {
        allPendingResolved: false,
        remainingExposedIds: [...this.exposedPending.keys()],
        newlyExposedCalls: [],
      }
    }

    // No parked work left: the next model step is a fresh continuation.
    this.turnOutputOpen = true
    return { allPendingResolved: true, remainingExposedIds: [], newlyExposedCalls: [] }
  }

  /**
   * Results that arrived after their wait was abandoned, oldest first. Taking
   * them is what lets a later prompt tell the model what it never received.
   */
  takeStrandedResults(): Array<{ callId: string; name: string; result: McpCallToolResult }> {
    const taken = this.stranded
    this.stranded = []
    return taken
  }

  /** Resolve every parked MCP call so `agy`'s HTTP client exits cleanly. */
  cancelAll(reason?: string): void {
    const text = reason || "Cancelled"
    const parked = [...this.currentBatch, ...this.queuedUnexposed, ...this.exposedPending.values()]
    this.currentBatch = []
    this.queuedUnexposed = []
    this.exposedPending.clear()
    this.clearBatchTimer()
    this.turnOutputOpen = false
    // Resolve the calls before aborting their waits: a waiter that aborts first
    // would win the race and report "cancelled" over the caller's real reason.
    for (const call of parked) {
      this.clearDeadline(call)
      call.resolve(errorResult(text))
    }
    for (const [id, controller] of this.waitersById) {
      this.waitersById.delete(id)
      controller.abort()
    }
    this.callsById.clear()
  }

  async handleJsonRpc(msg: unknown, ctx?: ToolCallContext): Promise<JsonRpcResponse> {
    if (!isObject(msg)) {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } }
    }

    const id = msg.id
    const method = typeof msg.method === "string" ? msg.method : ""
    const params = isObject(msg.params) ? msg.params : {}

    // Notifications (and anything without an id) are answered with 202 and no body.
    if (id === undefined || id === null) {
      if (method === "notifications/cancelled") this.cancelWait(params)
      return { status: 202, body: null }
    }

    switch (method) {
      case "server/discover":
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO },
          },
        }
      case "initialize": {
        const protocolVersion = typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : PROTOCOL_VERSION
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              // Stateless POST transport: never advertise `listChanged`.
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
            },
          },
        }
      }
      case "ping":
        return { status: 200, body: { jsonrpc: "2.0", id, result: {} } }
      case "tools/list":
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                ...this.normalizedTools.map((tool) => ({
                  name: tool.mcpName,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  _meta: ALWAYS_LOAD_META,
                })),
                // Advertised from the first `tools/list`: `agy` caches the catalog,
                // so a tool that appears only after a relay may never be seen.
                {
                  name: RELAY_TOOL_NAME,
                  description:
                    "Wait for the result of a tool call that answered that it is still running. Call this only when a tool result tells you to, passing the call_id it gave.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      call_id: {
                        type: "string",
                        description: "The call id from the still-running notice.",
                      },
                    },
                    required: ["call_id"],
                  },
                  _meta: ALWAYS_LOAD_META,
                },
              ],
            },
          },
        }
      case "tools/call":
        return await this.handleToolCall(id, params, ctx)
      default:
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          },
        }
    }
  }

  private async handleToolCall(
    id: unknown,
    params: Record<string, unknown>,
    ctx?: ToolCallContext,
  ): Promise<JsonRpcResponse> {
    const mcpName = typeof params.name === "string" ? params.name : ""
    if (mcpName === RELAY_TOOL_NAME) return await this.handleAwaitCall(id, params, ctx)
    const originalName = this.mcpToOriginal.get(mcpName)
    if (!originalName) {
      return { status: 200, body: { jsonrpc: "2.0", id, result: errorResult(`Unknown tool: ${mcpName}`) } }
    }

    if (this.toolChoice.type === "none") {
      this.rejectedNoneCount += 1
      if (this.rejectedNoneCount > this.maxRejectedNoneCalls) this.onFatalToolLoop?.(TOOL_LOOP_REASON)
      return { status: 200, body: { jsonrpc: "2.0", id, result: errorResult(TOOL_DISABLED_TEXT) } }
    }

    if (this.toolChoice.type === "tool" && originalName !== this.toolChoice.name) {
      this.rejectedChoiceCount += 1
      if (this.rejectedChoiceCount > this.maxRejectedNoneCalls) this.onFatalToolLoop?.(TOOL_LOOP_REASON)
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: errorResult(
            `Tool choice requires calling '${this.toolChoice.name}' in this turn, not '${originalName}'.`,
          ),
        },
      }
    }

    const call = this.parkCall(originalName, mcpName, ensureObject(params.arguments))
    return await this.answerParkedCall(id, call, ctx)
  }

  /**
   * Answers a `tools/call`, waiting for the caller's result but giving up the
   * transport after `relayAfterMs` so `agy` never reaches its 180 s deadline.
   */
  private async answerParkedCall(
    id: unknown,
    call: ParkedCall,
    ctx?: ToolCallContext,
  ): Promise<JsonRpcResponse> {
    if (call.relayWaits >= MAX_RELAY_WAITS) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: errorResult(
            `The bridge stopped waiting for tool call ${call.id} (${call.name}) after ${MAX_RELAY_WAITS} waits. ` +
            `It may still be running, and its result will not arrive here. Do not repeat the call.`,
          ),
        },
      }
    }
    const outcome = await this.waitForCall(id, call, ctx)
    if (outcome === RELAY) {
      call.relayWaits += 1
      return { status: 200, body: { jsonrpc: "2.0", id, result: relayNotice(call) } }
    }
    if (outcome === ABORTED) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: errorResult("The bridge stopped waiting: the tool call request was cancelled."),
        },
      }
    }
    return { status: 200, body: { jsonrpc: "2.0", id, result: outcome } }
  }

  /**
   * `mcp_magpie_await_result`: the model asking again for a result it has not
   * received. Handled inside the broker, so it never becomes a `tool_use`.
   */
  private async handleAwaitCall(
    id: unknown,
    params: Record<string, unknown>,
    ctx?: ToolCallContext,
  ): Promise<JsonRpcResponse> {
    const args = ensureObject(params.arguments)
    const callId = typeof args.call_id === "string" ? args.call_id.trim() : ""
    const call = callId ? this.callsById.get(callId) : undefined
    if (!call) {
      // The result may have landed between the "still running" notice and this
      // call. Nothing was waiting at that moment, so it was kept for the next
      // prompt; this is a better moment than that one, so hand it over now.
      const at = callId
        ? this.stranded.findIndex((entry) => entry.callId === callId)
        : -1
      if (at >= 0) {
        const [entry] = this.stranded.splice(at, 1)
        return {
          status: 200,
          body: { jsonrpc: "2.0", id, result: entry!.result },
        }
      }
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: errorResult(
            `No tool call "${callId}" is waiting. It may have finished before you asked, in which case its result is the tool result you already received. Do not repeat the original call.`,
          ),
        },
      }
    }
    return await this.answerParkedCall(id, call, ctx)
  }

  /** Races one parked call against the relay delay and the request's abort. */
  private async waitForCall(
    id: unknown,
    call: ParkedCall,
    ctx?: ToolCallContext,
  ): Promise<unknown> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (ctx?.signal) {
      if (ctx.signal.aborted) controller.abort()
      else ctx.signal.addEventListener("abort", onAbort, { once: true })
    }
    const tracked = typeof id === "string" || typeof id === "number"
    if (tracked) this.waitersById.set(id as string | number, controller)

    call.waiters += 1
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const racers: Array<Promise<unknown>> = [call.promise]
      if (this.relayAfterMs > 0) {
        racers.push(
          new Promise<unknown>((resolve) => {
            timer = setTimeout(() => resolve(RELAY), this.relayAfterMs)
          }),
        )
      }
      racers.push(
        new Promise<unknown>((resolve) => {
          // An event that already fired is not replayed: an aborted request must
          // settle here rather than wait out the relay delay.
          if (controller.signal.aborted) return resolve(ABORTED)
          controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })
        }),
      )
      return await Promise.race(racers)
    } finally {
      if (timer !== null) clearTimeout(timer)
      call.waiters -= 1
      ctx?.signal?.removeEventListener("abort", onAbort)
      if (tracked && this.waitersById.get(id as string | number) === controller) {
        this.waitersById.delete(id as string | number)
      }
    }
  }

  /** `notifications/cancelled` names the JSON-RPC request that is no longer wanted. */
  private cancelWait(params: Record<string, unknown>): void {
    const requestId = params.requestId
    if (typeof requestId !== "string" && typeof requestId !== "number") return
    this.waitersById.get(requestId)?.abort()
    this.waitersById.delete(requestId)
  }

  private parkCall(name: string, mcpName: string, input: Record<string, unknown>): ParkedCall {
    const call = createParkedCall(name, mcpName, input)
    this.callsById.set(call.id, call)
    this.armDeadline(call)
    if (this.turnOutputOpen) {
      this.currentBatch.push(call)
      // The window opens on the *first* call and is never extended by later ones.
      if (this.batchTimer === null && this.currentBatch.length === 1) this.startBatchTimer()
      // With parallel tool use disabled, the first call alone closes the turn:
      // siblings that arrive afterwards queue instead of joining this batch.
      if (this.currentBatch.length === 1 && this.disablesParallelToolUse()) {
        this.markHttpTurnClosed()
      }
    } else {
      this.queuedUnexposed.push(call)
    }
    return call
  }

  private disablesParallelToolUse(): boolean {
    const choice = this.toolChoice
    if (choice.type !== "auto" && choice.type !== "any" && choice.type !== "tool") return false
    return choice.disableParallelToolUse === true
  }

  private startBatchTimer(): void {
    const timer = setTimeout(() => {
      this.batchTimer = null
      this.markHttpTurnClosed()
    }, this.batchWindowMs)
    this.batchTimer = timer
  }

  private clearBatchTimer(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
  }

  private flushBatch(): void {
    this.clearBatchTimer()
    if (!this.currentBatch.length) return
    const batch = this.currentBatch
    this.currentBatch = []
    for (const call of batch) this.exposedPending.set(call.id, call)
    this.emitBatch(batch)
  }

  private emitBatch(batch: ParkedCall[]): void {
    this.onBatchReady?.(batch.map(toExposedCall))
  }

  private armDeadline(call: ParkedCall): void {
    const timer = setTimeout(() => this.expireCall(call), this.callDeadlineMs)
    // A parked call must never hold the process open on its own.
    const unref = (timer as { unref?: () => void }).unref
    if (typeof unref === "function") unref.call(timer)
    call.deadlineTimer = timer
  }

  private clearDeadline(call: ParkedCall): void {
    if (call.deadlineTimer !== null) {
      clearTimeout(call.deadlineTimer)
      call.deadlineTimer = null
    }
  }

  private expireCall(call: ParkedCall): void {
    call.deadlineTimer = null
    if (this.exposedPending.get(call.id) === call) this.exposedPending.delete(call.id)
    const queuedIndex = this.queuedUnexposed.indexOf(call)
    if (queuedIndex >= 0) this.queuedUnexposed.splice(queuedIndex, 1)
    const batchIndex = this.currentBatch.indexOf(call)
    if (batchIndex >= 0) this.currentBatch.splice(batchIndex, 1)
    call.resolve(errorResult(`Tool call timed out after ${this.callDeadlineMs}ms without a tool_result`))
    this.onCallExpired?.(call.id)
  }
}
