import { afterEach, describe, expect, test } from "bun:test"

import { LoopbackMcpServer, getSharedMcpServer } from "../src/mcp/http-server"
import { SessionToolBroker } from "../src/mcp/broker"
import type { ExposedToolCall, SessionToolBrokerOptions } from "../src/mcp/broker"
import { ensureGeminiArrayItems } from "../src/mcp/schema/array-items"
import {
  isRE2Safe,
  sanitizePatternFields,
  sanitizePatternString,
  translateUnicodeEscapes,
} from "../src/mcp/schema/re2-pattern"
import {
  normalizeToolDefinitions,
  sanitizeToolInputSchema,
  toMcpToolName,
} from "../src/mcp/schema/sanitizer"
import { BridgeHttpError } from "../src/types"
import type { ToolChoiceSpec } from "../src/types"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await sleep(5)
  }
}

function captureError(fn: () => void): BridgeHttpError {
  try {
    fn()
  } catch (error) {
    if (error instanceof BridgeHttpError) return error
    throw error
  }
  throw new Error("expected the call to throw")
}

interface TestBridge {
  broker: SessionToolBroker
  server: LoopbackMcpServer
  url: string
  token: string
  batches: ExposedToolCall[][]
  fatal: string[]
  close: () => void
}

const openBridges: Array<{ broker: SessionToolBroker; server: LoopbackMcpServer }> = []

function startBridge(options: SessionToolBrokerOptions = {}): TestBridge {
  const batches: ExposedToolCall[][] = []
  const fatal: string[] = []
  const broker = new SessionToolBroker({
    ...options,
    onBatchReady: (calls) => {
      batches.push(calls)
      options.onBatchReady?.(calls)
    },
    onFatalToolLoop: (reason) => {
      fatal.push(reason)
      options.onFatalToolLoop?.(reason)
    },
  })
  const server = new LoopbackMcpServer()
  const session = server.registerSession(broker)
  openBridges.push({ broker, server })
  return {
    broker,
    server,
    url: session.url,
    token: session.token,
    batches,
    fatal,
    close: () => {
      broker.cancelAll("test finished")
      server.stop()
    },
  }
}

afterEach(() => {
  while (openBridges.length) {
    const entry = openBridges.pop()
    entry?.broker.cancelAll("test finished")
    entry?.server.stop()
  }
})

function rpc(url: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  })
}

function callTool(
  url: string,
  name: string,
  args: unknown = {},
  id: number | string = 1,
  init: RequestInit = {},
): Promise<Response> {
  return rpc(url, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, init)
}

interface JsonRpcBody {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function readBody(response: Response): Promise<JsonRpcBody> {
  return (await response.json()) as JsonRpcBody
}

const echoToolSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
}

describe("re2-pattern", () => {
  test("translates unicode escapes and joins surrogate pairs", () => {
    expect(translateUnicodeEscapes("^[^\\u0000]*$")).toBe("^[^\\x{0000}]*$")
    expect(translateUnicodeEscapes("\\u{1F600}")).toBe("\\x{1F600}")
    expect(translateUnicodeEscapes("\\uD83D\\uDE00")).toBe("\\x{1F600}")
    expect(translateUnicodeEscapes("😀")).toBe("\\x{1F600}")
    // A literal backslash followed by `u0000` is not an escape.
    expect(translateUnicodeEscapes("\\\\u0000")).toBe("\\\\u0000")
  })

  test("accepts ECMA-safe constructs that RE2 also accepts", () => {
    expect(isRE2Safe("^[a-z]+$")).toBe(true)
    expect(isRE2Safe("^(?:foo|bar){2,3}$")).toBe(true)
    expect(isRE2Safe("\\p{Greek}+")).toBe(true)
    expect(isRE2Safe("(?<name>ab)+")).toBe(true)
    expect(isRE2Safe("a{2,10}")).toBe(true)
  })

  test("rejects constructs whose RE2 meaning differs from ECMA-262", () => {
    expect(isRE2Safe("(?=x)")).toBe(false)
    expect(isRE2Safe("(?!x)")).toBe(false)
    expect(isRE2Safe("(?<=x)")).toBe(false)
    expect(isRE2Safe("\\S")).toBe(false)
    expect(isRE2Safe("\\z")).toBe(false)
    expect(isRE2Safe("\\Qa\\E")).toBe(false)
    expect(isRE2Safe("[[:alpha:]]")).toBe(false)
    expect(isRE2Safe("\\p{Script=Greek}")).toBe(false)
    expect(isRE2Safe("(a)\\1")).toBe(false)
    expect(isRE2Safe("a{2,1}")).toBe(false)
    expect(isRE2Safe("(a{1000}){2}")).toBe(false)
    expect(isRE2Safe("a|")).toBe(true) // empty alternative is legal in RE2
  })

  test("sanitizePatternString reports keep/drop", () => {
    const kept = sanitizePatternString("^[^\\u0000]*$")
    expect(kept.ok).toBe(true)
    expect(kept.pattern).toBe("^[^\\x{0000}]*$")

    const dropped = sanitizePatternString("^(?=a)b$")
    expect(dropped.ok).toBe(false)
    expect(dropped.pattern).toBeUndefined()
    expect(dropped.original).toBe("^(?=a)b$")
  })

  test("sanitizePatternFields rewrites, drops, and hints", () => {
    const node = sanitizePatternFields({
      type: "object",
      properties: {},
      pattern: "^(?=a)",
      description: "field",
    }) as Record<string, unknown>
    expect(node.pattern).toBeUndefined()
    expect(node.description).toBe("field (pattern: ^(?=a))")

    const dropped = sanitizePatternFields({
      type: "object",
      patternProperties: { "^(?=a)": { type: "string" }, "^[a-z]+$": { type: "number" } },
      additionalProperties: false,
    }) as Record<string, unknown>
    expect(Object.keys(dropped.patternProperties as Record<string, unknown>)).toEqual(["^[a-z]+$"])
    expect(dropped.additionalProperties).toBe(false)

    const allDropped = sanitizePatternFields({
      type: "object",
      patternProperties: { "^(?=a)": { type: "string" } },
      additionalProperties: false,
    }) as Record<string, unknown>
    expect(allDropped.patternProperties).toBeUndefined()
    expect(allDropped.additionalProperties).toBeUndefined()
    expect(String(allDropped.description)).toContain("additionalProperties:false was lifted")
  })
})

describe("array-items", () => {
  test("fills untyped array items with a permissive schema", () => {
    const schema = ensureGeminiArrayItems({ type: "object", properties: { list: { type: "array" } } }) as {
      properties: { list: Record<string, unknown> }
    }
    const items = schema.properties.list.items as Record<string, unknown>
    expect(Array.isArray(items.anyOf)).toBe(true)
    expect(String(schema.properties.list.description)).toContain("array items were untyped")
  })

  test("leaves typed items alone and is idempotent", () => {
    const input = { type: "object", properties: { list: { type: "array", items: { type: "string" } } } }
    const once = ensureGeminiArrayItems(structuredClone(input))
    expect(once).toEqual(input)

    const untyped = { type: "object", properties: { list: { type: "array" } } }
    const first = ensureGeminiArrayItems(structuredClone(untyped))
    const second = ensureGeminiArrayItems(structuredClone(first))
    expect(second).toEqual(first)
  })

  test("lifts items out of array combinators and infers enum item types", () => {
    const lifted = ensureGeminiArrayItems({
      type: "array",
      anyOf: [{ type: "array", items: { type: "number" } }],
    }) as unknown as { items: Record<string, unknown> }
    expect(lifted.items).toEqual({ type: "number" })

    const fromEnum = ensureGeminiArrayItems({
      type: "array",
      items: { enum: ["a", "b"] },
    }) as { items: Record<string, unknown> }
    expect(fromEnum.items).toEqual({ enum: ["a", "b"], type: "string" })
  })

  test("hints tuple items instead of inventing a positional schema", () => {
    const tuple = ensureGeminiArrayItems({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    }) as Record<string, unknown>
    expect(Array.isArray(tuple.items)).toBe(true)
    expect(String(tuple.description)).toContain("tuple items")
  })
})

describe("sanitizer pipeline", () => {
  test("resolves $defs refs with RFC 6901 escapes and sanitizes patterns", () => {
    const schema = sanitizeToolInputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        "Options/a~b": {
          type: "object",
          description: "Base options",
          properties: {
            path: { type: "string", pattern: "^[^\\u0000]*$" },
            tags: { type: "array" },
          },
          required: ["path"],
        },
      },
      properties: {
        options: { $ref: "#/$defs/Options~1a~0b", description: "Search options" },
      },
    })

    expect(schema.$defs).toBeUndefined()
    expect(schema.$schema).toBeUndefined()
    const options = (schema.properties as Record<string, Record<string, unknown>>).options!
    expect(options.type).toBe("object")
    expect(options.description).toBe("Search options (Base options)")
    const inner = options.properties as Record<string, Record<string, unknown>>
    expect(inner.path?.pattern).toBe("^[^\\x{0000}]*$")
    expect(Array.isArray((inner.tags?.items as Record<string, unknown>).anyOf)).toBe(true)
  })

  test("terminates recursive $ref cycles with a hint", () => {
    const schema = sanitizeToolInputSchema({
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" }, value: { type: "string" } },
        },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
    })
    const root = (schema.properties as Record<string, Record<string, unknown>>).root!
    expect(root.type).toBe("object")
    const next = (root.properties as Record<string, Record<string, unknown>>).next!
    expect(String(next.description)).toContain("Recursive schema")
    expect(JSON.stringify(schema).length).toBeLessThan(20_000)
  })

  test("folds root-level oneOf without type:object into an object root", () => {
    const schema = sanitizeToolInputSchema({
      oneOf: [
        {
          type: "object",
          properties: { method: { type: "string", const: "screenshot" }, displayId: { type: "number" } },
          required: ["method"],
        },
        {
          type: "object",
          properties: { method: { type: "string", const: "click" } },
          required: ["method"],
        },
      ],
    })
    expect(schema.type).toBe("object")
    expect(schema.oneOf).toBeUndefined()
    expect(schema.anyOf).toBeUndefined()
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(properties).sort()).toEqual(["displayId", "method"])
    expect(schema.required).toEqual(["method"])
  })

  test("folds a mixed root anyOf into an object root", () => {
    const schema = sanitizeToolInputSchema({
      anyOf: [{ type: "string" }, { type: "object", properties: { path: { type: "string" } }, required: ["path"] }],
    })
    expect(schema.type).toBe("object")
    expect(schema.anyOf).toBeUndefined()
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.path?.type).toBe("string")
  })

  test("lowers nullable unions to type arrays", () => {
    const schema = sanitizeToolInputSchema({
      type: "object",
      properties: { tag: { anyOf: [{ type: "string" }, { type: "null" }] } },
    })
    const tag = (schema.properties as Record<string, Record<string, unknown>>).tag!
    expect(tag.type).toEqual(["string", "null"])
  })

  test("always yields an object root", () => {
    expect(sanitizeToolInputSchema({ type: "string" }).type).toBe("object")
    expect(String(sanitizeToolInputSchema({ type: "string" }).description)).toContain("requires an object root")
    expect(sanitizeToolInputSchema({}).type).toBe("object")
    expect(sanitizeToolInputSchema(undefined).type).toBe("object")
    // A nullable-object root still has to be a plain "object" string for agy.
    expect(sanitizeToolInputSchema({ type: ["object", "null"], properties: {} }).type).toBe("object")
    expect(ensureGeminiArrayItems(sanitizeToolInputSchema({ type: "object" })).type).toBe("object")
  })

  test("pipeline is idempotent for a nested schema", () => {
    const input = {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string" } },
        tag: { anyOf: [{ type: "string" }, { type: "null" }] },
        mode: { type: "string", enum: ["a", "b"] },
        ordered: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      },
      required: ["list", "missing"],
    }
    const once = sanitizeToolInputSchema(input)
    const twice = sanitizeToolInputSchema(once)
    expect(twice).toEqual(once)
    expect(once.required).toEqual(["list"])
  })
})

describe("tool name normalization", () => {
  test("keeps already valid names verbatim", () => {
    expect(toMcpToolName("read_file")).toBe("read_file")
    expect(toMcpToolName("mcp__foo_bar")).toBe("mcp__foo_bar")
    expect(toMcpToolName("a-b_c9")).toBe("a-b_c9")
  })

  test("hashes invalid names so dots and underscores cannot collide", () => {
    const dotted = toMcpToolName("mcp__foo.bar")
    const underscored = toMcpToolName("mcp__foo_bar")
    expect(underscored).toBe("mcp__foo_bar")
    expect(dotted).not.toBe(underscored)
    expect(dotted).toMatch(/^[A-Za-z0-9_-]{1,50}$/)
    expect(dotted).toMatch(/^mcp__foo_bar_[0-9a-f]{8}$/)
    // Deterministic.
    expect(toMcpToolName("mcp__foo.bar")).toBe(dotted)
  })

  test("truncates long names and re-hashes names that already end in a hash", () => {
    const long = toMcpToolName("x".repeat(80))
    expect(long.length).toBeLessThanOrEqual(50)
    expect(long).toBe(`${"x".repeat(41)}_${long.slice(-8)}`)

    const lookalike = toMcpToolName("a_b_0123abcd")
    expect(lookalike).not.toBe("a_b_0123abcd")
    expect(lookalike).toMatch(/_([0-9a-f]{8})$/)
  })

  test("normalizeToolDefinitions builds both maps and dedupes", () => {
    const normalized = normalizeToolDefinitions([
      { name: "mcp__foo.bar", description: "dotted", inputSchema: echoToolSchema },
      { name: "mcp__foo_bar", inputSchema: echoToolSchema },
      { name: "mcp__foo.bar", description: "duplicate", inputSchema: echoToolSchema },
      { name: "plain", inputSchema: { type: "array" } },
    ])

    expect(normalized.tools).toHaveLength(3)
    expect(normalized.tools.map((tool) => tool.originalName)).toEqual(["mcp__foo.bar", "mcp__foo_bar", "plain"])
    expect(normalized.tools[2]?.inputSchema.type).toBe("object")

    const dottedMcp = normalized.originalToMcp.get("mcp__foo.bar") ?? ""
    expect(normalized.mcpToOriginal.get(dottedMcp)).toBe("mcp__foo.bar")
    expect(normalized.mcpToOriginal.get("mcp__foo_bar")).toBe("mcp__foo_bar")
    expect(normalized.tools[0]?.description).toBe("dotted")
    expect(new Set(normalized.tools.map((tool) => tool.mcpName)).size).toBe(3)
  })
})

describe("LoopbackMcpServer security", () => {
  test("rejects unknown tokens, malformed paths, bad origins, and non-POST", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" }

    const badToken = await rpc(`http://127.0.0.1:${bridge.server.port}/mcp/${"0".repeat(64)}`, listBody)
    expect(badToken.status).toBe(401)

    const malformed = await rpc(`http://127.0.0.1:${bridge.server.port}/mcp/not-a-token`, listBody)
    expect(malformed.status).toBe(404)

    const badOrigin = await rpc(bridge.url, listBody, { headers: { origin: "https://evil.example" } })
    expect(badOrigin.status).toBe(403)

    const nullOrigin = await rpc(bridge.url, listBody, { headers: { origin: "null" } })
    expect(nullOrigin.status).toBe(403)

    const loopbackOrigin = await rpc(bridge.url, listBody, { headers: { origin: "http://localhost:5173" } })
    expect(loopbackOrigin.status).toBe(200)

    const get = await fetch(bridge.url)
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")

    const del = await fetch(bridge.url, { method: "DELETE" })
    expect(del.status).toBe(405)

    const porta = bridge.server.port
    const badHost = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json", host: `evil.example:${porta}` },
      body: JSON.stringify(listBody),
    })
    expect(badHost.status).toBe(403)
  })

  test("rejects oversized bodies and answers JSON-RPC batches", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])

    const oversized = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        padding: "x".repeat(4 * 1024 * 1024 + 16),
      }),
    })
    expect(oversized.status).toBe(413)

    const batch = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    })
    expect(batch.status).toBe(200)
    const bodies = (await batch.json()) as JsonRpcBody[]
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.result).toEqual({})
  })

  test("unregister removes the session", async () => {
    const broker = new SessionToolBroker()
    const server = new LoopbackMcpServer()
    openBridges.push({ broker, server })
    const session = server.registerSession(broker)
    const first = await rpc(session.url, { jsonrpc: "2.0", id: 1, method: "ping" })
    expect(first.status).toBe(200)
    session.unregister()
    const second = await rpc(session.url, { jsonrpc: "2.0", id: 2, method: "ping" })
    expect(second.status).toBe(401)
  })

  test("getSharedMcpServer is a lazy singleton", () => {
    const first = getSharedMcpServer()
    const second = getSharedMcpServer()
    expect(first).toBe(second)
    expect(first.port).toBeGreaterThan(0)
  })
})

describe("broker JSON-RPC surface", () => {
  test("initialize, ping, discover, notifications, and tools/list", async () => {
    const bridge = startBridge()
    const tools = bridge.broker.setTools([
      { name: "mcp__foo.bar", description: "dotted tool", inputSchema: echoToolSchema },
    ])

    const init = await rpc(bridge.url, {
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    })
    expect(init.status).toBe(200)
    const initBody = await readBody(init)
    expect(initBody.id).toBe(7)
    expect(initBody.result?.protocolVersion).toBe("2025-06-18")
    expect(initBody.result?.capabilities).toEqual({ tools: {} })
    expect(initBody.result?.serverInfo).toEqual({ name: "magpie-bridge", version: "0.1.0" })

    const initDefault = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 8, method: "initialize" }))
    expect(initDefault.result?.protocolVersion).toBe("2024-11-05")

    const ping = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 9, method: "ping" }))
    expect(ping.result).toEqual({})

    const discover = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 10, method: "server/discover" }))
    expect(discover.result?.protocolVersion).toBe("2024-11-05")
    expect(discover.result?.serverInfo).toEqual({ name: "magpie-bridge", version: "0.1.0" })

    const notified = await rpc(bridge.url, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(notified.status).toBe(202)
    expect(await notified.text()).toBe("")

    const cancelled = await rpc(bridge.url, { jsonrpc: "2.0", method: "notifications/cancelled" })
    expect(cancelled.status).toBe(202)

    const list = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 11, method: "tools/list" }))
    const listed = (list.result?.tools ?? []) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe(tools[0]?.mcpName)
    expect(listed[0]?.description).toBe("dotted tool")
    expect(listed[0]?._meta).toEqual({ "antigravity/alwaysLoad": true })
    expect((listed[0]?.inputSchema as Record<string, unknown>).type).toBe("object")

    const unknownMethod = await rpc(bridge.url, { jsonrpc: "2.0", id: 12, method: "tools/nope" })
    const unknownBody = await readBody(unknownMethod)
    expect(unknownBody.error?.code).toBe(-32601)

    const badJson = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(badJson.status).toBe(400)
    expect((await readBody(badJson)).error?.code).toBe(-32700)
  })

  test("unknown tool names fail without parking a call", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    const body = await readBody(await callTool(bridge.url, "nope", {}))
    const result = body.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("Unknown tool: nope")
    expect(bridge.broker.hasPendingWork()).toBe(false)
  })
})

describe("batch window and parked tools/call", () => {
  test("parallel identical calls expose two distinct toolu ids in one batch", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const first = callTool(bridge.url, "echo_tool", { text: "same" }, 1)
    const second = callTool(bridge.url, "echo_tool", { text: "same" }, 2)

    const batch = await waitFor(() => bridge.batches[0])
    expect(batch).toHaveLength(2)
    const ids = batch.map((call) => call.id)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^toolu_[0-9a-f]{24}$/)
    expect(batch[0]?.name).toBe("echo_tool")
    expect(batch[0]?.input).toEqual({ text: "same" })
    expect(batch[0]?.mcpName).toBe("echo_tool")

    const outcome = bridge.broker.deliverToolResults([
      { toolUseId: ids[0]!, isError: false, content: [{ type: "text", text: "first result" }] },
      { toolUseId: ids[1]!, isError: true, content: [{ type: "image", mediaType: "image/png", data: "AAAA" }] },
    ])
    expect(outcome).toEqual({ allPendingResolved: true, remainingExposedIds: [], newlyExposedCalls: [] })
    expect(bridge.broker.hasPendingWork()).toBe(false)

    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.status).toBe(200)
    const firstBody = await readBody(firstResponse)
    expect(firstBody.id).toBe(1)
    expect(firstBody.result).toEqual({ content: [{ type: "text", text: "first result" }] })

    const secondBody = await readBody(secondResponse)
    expect(secondBody.id).toBe(2)
    expect(secondBody.result).toEqual({
      isError: true,
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    })
  })

  test("an empty content array still yields one text part", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const pending = callTool(bridge.url, "echo_tool", {}, 3)
    const batch = await waitFor(() => bridge.batches[0])
    bridge.broker.deliverToolResults([{ toolUseId: batch[0]!.id, isError: false, content: [] }])
    const body = await readBody(await pending)
    expect(body.result).toEqual({ content: [{ type: "text", text: "" }] })
  })

  test("a late sibling queues and surfaces through newlyExposedCalls", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const first = callTool(bridge.url, "echo_tool", { text: "one" }, 1)
    const firstBatch = await waitFor(() => bridge.batches[0])
    expect(firstBatch).toHaveLength(1)
    expect(bridge.broker.getExposedPendingIds()).toEqual([firstBatch[0]!.id])

    // +60ms: well after the 30ms window flushed and closed the HTTP turn.
    await sleep(60)
    const second = callTool(bridge.url, "echo_tool", { text: "two" }, 2)
    await sleep(60)
    expect(bridge.batches).toHaveLength(1)
    expect(bridge.broker.hasPendingWork()).toBe(true)

    const afterFirst = bridge.broker.deliverToolResults([
      { toolUseId: firstBatch[0]!.id, isError: false, content: [{ type: "text", text: "one done" }] },
    ])
    expect(afterFirst.allPendingResolved).toBe(false)
    expect(afterFirst.newlyExposedCalls).toHaveLength(1)
    const lateCall = afterFirst.newlyExposedCalls[0]!
    expect(lateCall.input).toEqual({ text: "two" })
    expect(lateCall.id).not.toBe(firstBatch[0]!.id)
    expect(afterFirst.remainingExposedIds).toEqual([lateCall.id])

    const afterLate = bridge.broker.deliverToolResults([
      { toolUseId: lateCall.id, isError: false, content: [{ type: "text", text: "two done" }] },
    ])
    expect(afterLate).toEqual({ allPendingResolved: true, remainingExposedIds: [], newlyExposedCalls: [] })
    expect(bridge.broker.hasPendingWork()).toBe(false)

    const firstBody = await readBody(await first)
    expect(firstBody.result).toEqual({ content: [{ type: "text", text: "one done" }] })
    const secondBody = await readBody(await second)
    expect(secondBody.id).toBe(2)
    expect(secondBody.result).toEqual({ content: [{ type: "text", text: "two done" }] })
  })

  test("flushCurrentBatchNow exposes immediately when text/end arrives", async () => {
    const bridge = startBridge({ batchWindowMs: 5_000 })
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const pending = callTool(bridge.url, "echo_tool", {}, 1)
    await sleep(50)
    expect(bridge.batches).toHaveLength(0)
    bridge.broker.flushCurrentBatchNow()
    const batch = await waitFor(() => bridge.batches[0])
    expect(batch).toHaveLength(1)

    bridge.broker.deliverToolResults([{ toolUseId: batch[0]!.id, isError: false, content: [{ type: "text", text: "ok" }] }])
    expect((await readBody(await pending)).result).toEqual({ content: [{ type: "text", text: "ok" }] })
  })

  test("deliverToolResults rejects unknown and duplicate ids", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const pending = callTool(bridge.url, "echo_tool", {}, 1)
    const batch = await waitFor(() => bridge.batches[0])
    const id = batch[0]!.id

    const unknown = captureError(() =>
      bridge.broker.deliverToolResults([{ toolUseId: "toolu_deadbeef", isError: false, content: [] }]))
    expect(unknown.status).toBe(400)
    expect(unknown.errorType).toBe("invalid_request_error")
    expect(unknown.message).toContain("Unknown or unexposed tool_use_id: toolu_deadbeef")

    const duplicate = captureError(() =>
      bridge.broker.deliverToolResults([
        { toolUseId: id, isError: false, content: [] },
        { toolUseId: id, isError: false, content: [] },
      ]))
    expect(duplicate.status).toBe(409)
    expect(duplicate.message).toBe(`Duplicate tool_result for ${id}`)

    // The duplicate rejection must not have resolved anything.
    expect(bridge.broker.getExposedPendingIds()).toEqual([id])
    bridge.broker.deliverToolResults([{ toolUseId: id, isError: false, content: [{ type: "text", text: "done" }] }])
    await readBody(await pending)

    const replayed = captureError(() =>
      bridge.broker.deliverToolResults([{ toolUseId: id, isError: false, content: [] }]))
    expect(replayed.status).toBe(400)
  })

  test("cancelAll resolves parked calls so the HTTP client does not hang", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.openTurnWindow()

    const pending = callTool(bridge.url, "echo_tool", {}, 1)
    await waitFor(() => bridge.batches[0])
    bridge.broker.cancelAll("worker stopped")

    const body = await readBody(await pending)
    expect(body.result).toEqual({ isError: true, content: [{ type: "text", text: "worker stopped" }] })
    expect(bridge.broker.hasPendingWork()).toBe(false)
  })
})

describe("tool_choice none", () => {
  test("keeps tools/list identical but rejects calls without exposing them", async () => {
    const bridge = startBridge()
    bridge.broker.setTools([
      { name: "echo_tool", description: "echo", inputSchema: echoToolSchema },
      { name: "second_tool", inputSchema: echoToolSchema },
    ])

    const before = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }))
    bridge.broker.setToolChoice({ type: "none" } satisfies ToolChoiceSpec)
    const after = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 2, method: "tools/list" }))

    expect(after.result?.tools).toEqual(before.result?.tools)
    expect((after.result?.tools as unknown[]).length).toBe(2)

    bridge.broker.openTurnWindow()
    const rejected = await readBody(await callTool(bridge.url, "echo_tool", { text: "hi" }))
    const result = rejected.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      "Tool calls are disabled for this turn (tool_choice=none). Respond directly in plain text.",
    )
    expect(bridge.batches).toHaveLength(0)
    expect(bridge.broker.hasPendingWork()).toBe(false)

    // Resetting the choice clears the rejection counter.
    bridge.broker.setToolChoice({ type: "auto" })
    expect(bridge.broker.getToolChoice()).toEqual({ type: "auto" })
  })

  test("fires onFatalToolLoop once the rejection budget is exhausted", async () => {
    const bridge = startBridge({ maxRejectedNoneCalls: 1 })
    bridge.broker.setTools([{ name: "echo_tool", inputSchema: echoToolSchema }])
    bridge.broker.setToolChoice({ type: "none" })
    bridge.broker.openTurnWindow()

    await readBody(await callTool(bridge.url, "echo_tool", {}, 1))
    expect(bridge.fatal).toHaveLength(0)
    await readBody(await callTool(bridge.url, "echo_tool", {}, 2))
    expect(bridge.fatal).toEqual(["Model repeatedly attempted tool calls while tool_choice is none"])

    // Still no tool_use was ever exposed.
    expect(bridge.batches).toHaveLength(0)
    expect(bridge.broker.getExposedPendingIds()).toEqual([])
  })
})
