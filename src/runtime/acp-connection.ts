import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type StderrRedactor = (text: string) => string;

export interface AcpConnectionOptions {
  redactor?: StderrRedactor;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  id: number | string;
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

class StderrRingBuffer {
  private readonly capacity: number;
  private buffer: Buffer;
  private writePos = 0;
  private isFull = false;

  constructor(capacityBytes: number = 16 * 1024) {
    this.capacity = capacityBytes;
    this.buffer = Buffer.alloc(capacityBytes);
  }

  push(chunk: Buffer | Uint8Array | string): void {
    const data =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (data.length >= this.capacity) {
      data.copy(this.buffer, 0, data.length - this.capacity, data.length);
      this.writePos = 0;
      this.isFull = true;
      return;
    }

    const spaceToEnd = this.capacity - this.writePos;
    if (data.length <= spaceToEnd) {
      data.copy(this.buffer, this.writePos);
      this.writePos += data.length;
      if (this.writePos === this.capacity) {
        this.writePos = 0;
        this.isFull = true;
      }
    } else {
      data.copy(this.buffer, this.writePos, 0, spaceToEnd);
      const remaining = data.length - spaceToEnd;
      data.copy(this.buffer, 0, spaceToEnd, data.length);
      this.writePos = remaining;
      this.isFull = true;
    }
  }

  toString(): string {
    if (!this.isFull) {
      return this.buffer.subarray(0, this.writePos).toString("utf-8");
    }
    const part1 = this.buffer.subarray(this.writePos);
    const part2 = this.buffer.subarray(0, this.writePos);
    return Buffer.concat([part1, part2]).toString("utf-8");
  }
}

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly redactor?: StderrRedactor;
  private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly stderrBuffer = new StderrRingBuffer(16 * 1024);
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly sessionUpdateListeners = new Set<(params: any) => void>();
  private nextId = 1;
  private stdoutRemainder = "";
  private isClosed = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    options?: AcpConnectionOptions,
  ) {
    this.child = child;
    this.redactor = options?.redactor;
    this.onExit = options?.onExit;

    this.setupStreams();
  }

  private setupStreams(): void {
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdoutRemainder += chunk;
      const lines = this.stdoutRemainder.split("\n");
      this.stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.handleIncomingLine(trimmed);
        }
      }
    });

    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer.push(chunk);
    });

    const handleExit = (code: number | null, signal: string | null) => {
      if (this.isClosed) return;
      this.isClosed = true;

      const stderrTail = this.getStderrTail();
      const exitMsg = `ACP process exited (code: ${code ?? "null"}, signal: ${signal ?? "null"}). Stderr tail:\n${stderrTail}`;

      for (const [id, pending] of this.pendingRequests) {
        if (pending.timeoutTimer) {
          clearTimeout(pending.timeoutTimer);
        }
        pending.reject(
          new Error(
            `ACP request '${pending.method}' (id: ${id}) aborted: ${exitMsg}`,
          ),
        );
      }
      this.pendingRequests.clear();

      try {
        this.onExit?.(code, signal as NodeJS.Signals | null);
      } catch {}
    };

    this.child.on("exit", handleExit);
    this.child.on("close", handleExit);
    this.child.on("error", (err: Error) => {
      handleExit(null, err.message);
    });
    this.child.stdin.on("error", (err: Error) => {
      this.stderrBuffer.push(
        `\n[AcpConnection stdin error]: ${err?.message ?? String(err)}\n`,
      );
      handleExit(null, `stdin: ${err?.message ?? String(err)}`);
    });
  }

  private handleIncomingLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Ignore non-JSON output
      return;
    }

    if (!msg || typeof msg !== "object") {
      return;
    }

    // 1. Response to an outgoing request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (pending.timeoutTimer) {
          clearTimeout(pending.timeoutTimer);
        }
        if (msg.error) {
          const err = new Error(
            msg.error.message || `JSON-RPC error ${msg.error.code}`,
          );
          (err as any).code = msg.error.code;
          (err as any).data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Server-initiated request (has method AND id)
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        let outcome: unknown = { outcome: "cancelled" };
        const options = msg.params?.options;
        if (Array.isArray(options)) {
          const rejectOpt = options.find((o: any) => {
            if (!o || typeof o !== "object") return false;
            const fields = [o.kind, o.optionId, o.id, o.name, o.label];
            return fields.some(
              (f) => typeof f === "string" && /reject|deny|cancel/i.test(f),
            );
          });
          const optionId = rejectOpt?.optionId ?? rejectOpt?.id;
          if (rejectOpt && optionId !== undefined) {
            outcome = { outcome: "selected", optionId };
          }
        }
        this.sendResponse(msg.id, { outcome });
        return;
      }

      // Any other server request -> JSON-RPC -32601 Method not found
      this.sendError(msg.id, -32601, `Method not found: ${msg.method}`);
      return;
    }

    // 3. Server notification (has method, no id)
    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        for (const listener of this.sessionUpdateListeners) {
          try {
            listener(msg.params);
          } catch {
            // Protect against faulty listeners
          }
        }
      }
    }
  }

  private sendResponse(id: number | string, result: unknown): void {
    if (this.isClosed || !this.child.stdin.writable) return;
    const body = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.child.stdin.write(body);
  }

  private sendError(
    id: number | string,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (this.isClosed || !this.child.stdin.writable) return;
    const errorObj: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      errorObj.data = data;
    }
    const body =
      JSON.stringify({ jsonrpc: "2.0", id, error: errorObj }) + "\n";
    this.child.stdin.write(body);
  }

  request<T = any>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = 60_000,
  ): Promise<T> {
    if (this.isClosed || !this.child.stdin.writable) {
      return Promise.reject(
        new Error(`Cannot send ACP request '${method}': process closed`),
      );
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          this.pendingRequests.delete(id);
          const stderrTail = this.getStderrTail();
          reject(
            new Error(
              `ACP request '${method}' (id: ${id}) timed out after ${timeoutMs}ms. Stderr tail:\n${stderrTail}`,
            ),
          );
        }, timeoutMs);
      }

      this.pendingRequests.set(id, {
        id,
        method,
        resolve,
        reject,
        timeoutTimer,
      });

      try {
        this.child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.isClosed || !this.child.stdin.writable) return;
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      // Best effort notification
    }
  }

  onSessionUpdate(listener: (params: any) => void): () => void {
    this.sessionUpdateListeners.add(listener);
    return () => {
      this.sessionUpdateListeners.delete(listener);
    };
  }

  getStderrTail(): string {
    const raw = this.stderrBuffer.toString();
    if (this.redactor) {
      try {
        return this.redactor(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    for (const [id, pending] of this.pendingRequests) {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
      pending.reject(
        new Error(`ACP request '${pending.method}' (id: ${id}) aborted on close`),
      );
    }
    this.pendingRequests.clear();
    this.sessionUpdateListeners.clear();

    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.stdout.removeAllListeners("data");
      this.child.stderr.removeAllListeners("data");
    } catch {}
  }
}
