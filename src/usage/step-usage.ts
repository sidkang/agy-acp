import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDescriptor, TokenUsageSummary } from "../types";

export interface StepTokenUsage {
  idx: number;
  input: number;
  output: number;
  write: number;
  read: number;
  thinking: number;
  context?: number;
}

let opener:
  | ((file: string) => {
      all: (sql: string, ...args: any[]) => any[];
      close: () => void;
    })
  | null = null;

function getDbOpener() {
  if (opener !== null) return opener;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    if (typeof Database === "function") {
      opener = (file: string) => {
        const db = new Database(file, { readonly: true });
        return {
          all: (sql: string, ...args: any[]) => {
            const stmt = db.prepare(sql);
            try {
              return stmt.all(...args);
            } finally {
              try {
                stmt.finalize?.();
              } catch {}
            }
          },
          close: () => {
            try {
              db.close();
            } catch {}
          },
        };
      };
      return opener;
    }
  } catch {}

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      opener = (file: string) => {
        const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
        return {
          all: (sql: string, ...args: any[]) => db.prepare(sql).all(...args),
          close: () => {
            try {
              db.close();
            } catch {}
          },
        };
      };
      return opener;
    }
  } catch {}

  return null;
}

function varint(
  buf: Uint8Array,
  at: number,
): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    const byte = buf[at + i];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
    scale *= 128;
  }
  return null;
}

function walk(
  buf: Uint8Array,
  fn: (field: number, wire: number, val: any) => void,
): boolean {
  let at = 0;
  while (at < buf.length) {
    const tag = varint(buf, at);
    if (!tag || tag.value < 8) return false;
    at = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const item = varint(buf, at);
      if (!item) return false;
      at = item.next;
      fn(field, wire, item.value);
    } else if (wire === 2) {
      const len = varint(buf, at);
      if (!len || len.next + len.value > buf.length) return false;
      fn(field, wire, buf.subarray(len.next, len.next + len.value));
      at = len.next + len.value;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > buf.length) return false;
    } else {
      return false;
    }
  }
  return true;
}

const count = (value: any): number =>
  Number.isSafeInteger(value) && value > 0 ? value : 0;

function decodeUsage(buf: Uint8Array): {
  input: number;
  output: number;
  write: number;
  read: number;
  thinking: number;
} | null {
  const usage = { input: 0, output: 0, write: 0, read: 0, thinking: 0 };
  const ok = walk(buf, (field, wire, n) => {
    if (wire !== 0) return;
    if (field === 2) usage.input = count(n);
    else if (field === 3) usage.output = count(n);
    else if (field === 4) usage.write = count(n);
    else if (field === 5) usage.read = count(n);
    else if (field === 9) usage.thinking = count(n);
  });
  return ok ? usage : null;
}

export function decodeStepUsage(metadata: any): {
  input: number;
  output: number;
  write: number;
  read: number;
  thinking: number;
} | null {
  const buf =
    metadata instanceof Uint8Array
      ? metadata
      : ArrayBuffer.isView(metadata)
        ? new Uint8Array(
            metadata.buffer,
            metadata.byteOffset,
            metadata.byteLength,
          )
        : null;
  if (!buf) return null;
  let stats: any = null;
  const ok = walk(buf, (field, wire, value) => {
    if (field !== 9 || wire !== 2) return;
    stats = decodeUsage(value);
  });
  return ok ? stats : null;
}

export function decodeGenerationUsage(data: any): {
  input: number;
  output: number;
  write: number;
  read: number;
  thinking: number;
  context?: number;
} | null {
  const buf =
    data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!buf) return null;
  let stats: any = null;
  let context: number | null = null;
  let valid = true;
  const ok =
    walk(buf, (field, wire, chat) => {
      if (field !== 1 || wire !== 2) return;
      valid =
        walk(chat, (sub, subWire, value) => {
          if (subWire !== 2) return;
          if (sub === 4) {
            stats = decodeUsage(value);
            if (!stats) valid = false;
          } else if (sub === 9) {
            if (
              !walk(value, (key, kind, start) => {
                if (key !== 10 || kind !== 2) return;
                if (
                  !walk(start, (k, w, n) => {
                    if (k === 1 && w === 0) context = count(n);
                  })
                )
                  valid = false;
              })
            )
              valid = false;
          }
        }) && valid;
    }) && valid;
  return ok && valid && stats
    ? { ...stats, ...(context !== null ? { context } : {}) }
    : null;
}

export function resolveConversationDbPath(
  account: AccountDescriptor,
  nativeSessionId: string,
): string | null {
  if (!nativeSessionId || !/^[A-Za-z0-9._-]+$/.test(String(nativeSessionId))) {
    return null;
  }
  if (process.env.AGY_BRIDGE_CONVERSATIONS_DIR) {
    return path.join(
      process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
      `${nativeSessionId}.db`,
    );
  }
  const homeDir =
    account.isolatedHomeDir ?? process.env.HOME ?? os.homedir();
  return path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${nativeSessionId}.db`,
  );
}

export function readConversationStepUsages(
  account: AccountDescriptor,
  nativeSessionId: string,
): StepTokenUsage[] {
  const dbPath = resolveConversationDbPath(account, nativeSessionId);
  if (!dbPath || !fs.existsSync(dbPath)) {
    return [];
  }

  const open = getDbOpener();
  if (!open) return [];

  let db: ReturnType<typeof open> | null = null;
  try {
    db = open(dbPath);

    // 1. Try gen_metadata first
    try {
      const genRows = db.all("SELECT idx, data FROM gen_metadata ORDER BY idx");
      if (Array.isArray(genRows) && genRows.length > 0) {
        const steps: StepTokenUsage[] = [];
        for (const row of genRows) {
          const idx = Number(row?.idx);
          const usage = decodeGenerationUsage(row?.data);
          if (
            Number.isSafeInteger(idx) &&
            usage &&
            usage.input +
              usage.read +
              usage.write +
              usage.output +
              usage.thinking >
              0
          ) {
            steps.push({ idx, ...usage });
          }
        }
        if (steps.length > 0) {
          return steps;
        }
      }
    } catch {}

    // 2. Fall back to steps table (step_type = 15, status = 3)
    try {
      const stepRows = db.all(
        "SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 ORDER BY idx",
      );
      if (Array.isArray(stepRows) && stepRows.length > 0) {
        const steps: StepTokenUsage[] = [];
        for (const row of stepRows) {
          const idx = Number(row?.idx);
          const usage = decodeStepUsage(row?.metadata);
          if (Number.isSafeInteger(idx) && usage) {
            steps.push({ idx, ...usage });
          }
        }
        return steps;
      }
    } catch {}

    return [];
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function tokenCount(v: any): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function normalizeRawAcpUsage(usage: any): {
  input: number;
  read: number;
  write: number;
  output: number;
  thinking: number;
  promptInput: number;
} {
  if (!usage || typeof usage !== "object") {
    return {
      input: 0,
      read: 0,
      write: 0,
      output: 0,
      thinking: 0,
      promptInput: 0,
    };
  }
  const rawInput = tokenCount(usage.inputTokens ?? usage.input_tokens);
  const cacheRead = tokenCount(
    usage.cachedReadTokens ??
      usage.cacheReadInputTokens ??
      usage.cache_read_input_tokens,
  );
  const cacheWrite = tokenCount(
    usage.cachedWriteTokens ??
      usage.cacheCreationInputTokens ??
      usage.cache_creation_input_tokens,
  );
  const output = tokenCount(usage.outputTokens ?? usage.output_tokens);
  const thinking = tokenCount(usage.thoughtTokens ?? usage.thinking_tokens);
  const total = tokenCount(usage.totalTokens ?? usage.total_tokens);

  const inclusive =
    total > 0
      ? Math.abs(total - (rawInput + output)) <
        Math.abs(total - (rawInput + cacheRead + cacheWrite + output))
      : cacheRead <= rawInput;

  const promptInput = inclusive ? rawInput : rawInput + cacheRead;
  const read = Math.min(cacheRead, promptInput);

  return {
    input: promptInput - read,
    read,
    write: cacheWrite,
    output: Math.max(output, thinking),
    thinking,
    promptInput,
  };
}

export function settleStepUsage(
  rawAcpUsage: any,
  stepCountInPrompt: number,
  stepMeasurements?: Array<StepTokenUsage | TokenUsageSummary>,
): TokenUsageSummary {
  if (stepMeasurements && stepMeasurements.length > 0) {
    const latest = stepMeasurements[stepMeasurements.length - 1]!;
    if ("inputTokens" in latest) {
      return {
        inputTokens: latest.inputTokens,
        outputTokens: latest.outputTokens,
        cacheReadInputTokens: latest.cacheReadInputTokens,
        cacheCreationInputTokens: latest.cacheCreationInputTokens,
      };
    }
    return {
      inputTokens: latest.input,
      outputTokens: Math.max(latest.output, latest.thinking ?? 0),
      cacheReadInputTokens: latest.read,
      cacheCreationInputTokens: latest.write,
    };
  }

  const normalized = normalizeRawAcpUsage(rawAcpUsage);
  const count = Math.max(1, stepCountInPrompt);
  if (count > 1) {
    return {
      inputTokens: Math.round(normalized.input / count),
      outputTokens: normalized.output,
      cacheReadInputTokens: Math.round(normalized.read / count),
      cacheCreationInputTokens: Math.round(normalized.write / count),
    };
  }

  return {
    inputTokens: normalized.input,
    outputTokens: normalized.output,
    cacheReadInputTokens: normalized.read,
    cacheCreationInputTokens: normalized.write,
  };
}
