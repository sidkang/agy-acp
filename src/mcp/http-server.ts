// Loopback-only MCP Streamable-HTTP server.
//
// `agy` is configured with `http://127.0.0.1:<port>/mcp/<token>` for the
// `magpie` MCP server. Every request is authenticated by a 32-byte session
// token compared in constant time, bound to loopback Host/Origin, and limited
// to POST bodies under 4 MiB. The transport is stateless: each JSON-RPC request
// is answered on its own POST, and a `tools/call` POST simply stays open until
// the bridge delivers the matching `tool_result`.

import { randomBytes, timingSafeEqual } from "node:crypto"

import { SessionToolBroker } from "./broker"

const TOKEN_PATH_RE = /^\/mcp\/([0-9a-f]{64})$/
const TOKEN_BYTES = 32
const MAX_BODY_BYTES = 4 * 1024 * 1024
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"])

export interface RegisteredSession {
  token: string
  url: string
  unregister: () => void
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return jsonResponse(status, { jsonrpc: "2.0", id: null, error: { code, message } })
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function isLoopbackOrigin(origin: string): boolean {
  let hostname: string
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    hostname = normalizeHostname(url.hostname)
  } catch {
    return false
  }
  return LOOPBACK_HOSTNAMES.has(hostname)
}

export class LoopbackMcpServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly sessions = new Map<string, SessionToolBroker>()

  constructor() {
    this.start()
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  registerSession(broker: SessionToolBroker): RegisteredSession {
    this.start()
    const token = randomBytes(TOKEN_BYTES).toString("hex")
    this.sessions.set(token, broker)
    return {
      token,
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      unregister: () => {
        this.sessions.delete(token)
      },
    }
  }

  stop(): void {
    const server = this.server
    this.server = null
    this.sessions.clear()
    server?.stop(true)
  }

  /** (Re)starts a stopped server; a no-op while one is already listening. */
  start(): void {
    if (this.server) return
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // Long-lived `tools/call` POSTs park until the caller delivers a result.
      idleTimeout: 255,
      maxRequestBodySize: MAX_BODY_BYTES,
      // `server.port` is authoritative even before the field is assigned.
      fetch: (request, server) => {
        const path = new URL(request.url).pathname
        if (request.method === "POST" && TOKEN_PATH_RE.test(path)) {
          if (typeof (server as any)?.timeout === "function") {
            (server as any).timeout(request, 0)
          }
        }
        return this.handleRequest(request, server.port ?? this.server?.port ?? 0)
      },
    })
  }

  private findSession(token: string): SessionToolBroker | null {
    const candidate = Buffer.from(token, "hex")
    if (candidate.length !== TOKEN_BYTES) return null
    let found: SessionToolBroker | null = null
    // Compare against every registered token so lookup time does not reveal
    // how much of the presented token matched.
    for (const [key, broker] of this.sessions) {
      const known = Buffer.from(key, "hex")
      if (known.length !== candidate.length) continue
      if (timingSafeEqual(known, candidate)) found = broker
    }
    return found
  }

  private async handleRequest(request: Request, port: number): Promise<Response> {
    const url = new URL(request.url)
    const match = TOKEN_PATH_RE.exec(url.pathname)
    if (!match) return new Response("Not Found", { status: 404 })
    const token = match[1] ?? ""

    const host = (request.headers.get("host") ?? "").toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return new Response("Forbidden", { status: 403 })
    }

    const origin = request.headers.get("origin")
    if (origin !== null && !isLoopbackOrigin(origin)) {
      return new Response("Forbidden", { status: 403 })
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } })
    }

    const broker = this.findSession(token)
    if (!broker) return new Response("Unauthorized", { status: 401 })

    const declaredLength = request.headers.get("content-length")
    if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 })
    }

    let text: string
    try {
      const buffer = await request.arrayBuffer()
      if (buffer.byteLength > MAX_BODY_BYTES) return new Response("Payload Too Large", { status: 413 })
      text = new TextDecoder().decode(buffer)
    } catch {
      return new Response("Bad Request", { status: 400 })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return jsonRpcError(400, -32700, "Parse error")
    }

    if (Array.isArray(parsed)) {
      const bodies: unknown[] = []
      let status = 0
      for (const message of parsed) {
        const result = await broker.handleJsonRpc(message, { signal: request.signal })
        if (result.body === null) continue
        // Notifications inside a batch must not downgrade the batch status.
        if (!status) status = result.status
        bodies.push(result.body)
      }
      if (!bodies.length) return new Response(null, { status: 202 })
      return jsonResponse(status, bodies)
    }

    const result = await broker.handleJsonRpc(parsed, { signal: request.signal })
    if (result.body === null) return new Response(null, { status: result.status })
    return jsonResponse(result.status, result.body)
  }
}

let sharedServer: LoopbackMcpServer | null = null

export function getSharedMcpServer(): LoopbackMcpServer {
  if (!sharedServer) sharedServer = new LoopbackMcpServer()
  // A previous owner may have called `stop()` on the singleton (test teardown
  // does), which leaves it with port 0; restart it while keeping identity.
  sharedServer.start()
  return sharedServer
}
