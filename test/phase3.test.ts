import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

import {
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type NormalizedMessage,
  type TurnStreamEvent,
} from "../src/types";
import {
  digestMessagesForPersistence,
  heardRuns,
  isCompactedRequest,
  isPrefixMatch,
  lostMedia,
  matchLedgerPrefix,
  matchPersistedPrefix,
} from "../src/sessions/ledger";
import {
  MAX_PARKED_SESSIONS,
  MAX_PERSISTED_PARKED_SESSIONS,
  MAX_SINGLE_PARKED_BYTES,
  PARKED_SESSION_TTL_MS,
  SHELF_FILE_NAME,
  ShelfStore,
  type WorkerParkSnapshot,
} from "../src/sessions/shelf-store";
import {
  MAX_DECODE_HOLD_BYTES,
  MAX_INLINE_IMAGE_BASE64_BYTES,
  MAX_INLINE_IMAGE_SIDE,
  decodeImageRgba,
  encodeJpegRgba,
  encodePngRgba,
  fitInlineImage,
  getFittedImageCacheSize,
  readImageDimensions,
} from "../src/protocol/images";
import { decodeWebp } from "../src/protocol/webp";
import { SessionToolBroker } from "../src/mcp/broker";
import { getSharedMcpServer } from "../src/mcp/http-server";
import {
  planColdHistoryRender,
  renderMessagesToPrompt,
} from "../src/sessions/prompt-render";
import { CONTEXT_BUDGET_FAILURE_MESSAGE } from "../src/runtime/diagnostics";
import { encodeAnthropicSseResponse } from "../src/protocol/anthropic";
import {
  AsyncEventQueue,
  DEFAULT_MAX_TURN_QUEUE_BYTES,
  TurnContext,
} from "../src/runtime/turn-context";
import { StepUsageTracker } from "../src/usage/tracker";
import { usageFromAcpPromptResult } from "../src/usage/step-usage";
import { GlobalScheduler } from "../src/runtime/scheduler";
import { AgySessionWorker, type ModelSelection } from "../src/runtime/worker";
import { SessionCoordinator } from "../src/sessions/coordinator";
import {
  combineSignals,
  createLoginSessionDisposer,
} from "../src/accounts/auth";
import pluginEntry from "../src/index";
import { spawnFakeAcp } from "./fixtures/helpers";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const tempDirs: string[] = [];
const activeSchedulers: GlobalScheduler[] = [];

function makeTempDir(prefix = "agy-phase3-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAccount(
  suffix = "a",
  isolatedHomeDir: string | null = null,
): AccountDescriptor {
  return {
    slotKey: `agy-acp#slot-${suffix}`,
    accountRef: `acct-${suffix}`,
    mode: isolatedHomeDir ? "isolated" : "host",
    label: `test-${suffix}`,
    isolatedHomeDir,
  };
}

async function withDataDir<T>(
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = process.env.AGY_ACP_DATA_DIR;
  process.env.AGY_ACP_DATA_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGY_ACP_DATA_DIR;
    else process.env.AGY_ACP_DATA_DIR = prev;
  }
}

async function withConversationsDir<T>(
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = process.env.AGY_BRIDGE_CONVERSATIONS_DIR;
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGY_BRIDGE_CONVERSATIONS_DIR;
    else process.env.AGY_BRIDGE_CONVERSATIONS_DIR = prev;
  }
}

function makeSolidRgba(
  width: number,
  height: number,
  r = 24,
  g = 128,
  b = 216,
  a = 255,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
  return rgba;
}

function makeNoisyRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 0x12345678;
  for (let i = 0; i < rgba.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rgba[i] = seed & 0xff;
    rgba[i + 1] = (seed >>> 8) & 0xff;
    rgba[i + 2] = (seed >>> 16) & 0xff;
    rgba[i + 3] = 255;
  }
  return rgba;
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function pbVarintField(field: number, value: number): Uint8Array {
  return new Uint8Array([...encodeVarint((field << 3) | 0), ...encodeVarint(value)]);
}

function pbBytesField(field: number, payload: Uint8Array): Uint8Array {
  const hdr = new Uint8Array([
    ...encodeVarint((field << 3) | 2),
    ...encodeVarint(payload.length),
  ]);
  const out = new Uint8Array(hdr.length + payload.length);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  return out;
}

function pbConcat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeGenMetadataBlob(stats: {
  input: number;
  output: number;
  write?: number;
  read?: number;
  thinking?: number;
}): Uint8Array {
  const usage = pbConcat(
    pbVarintField(2, stats.input),
    pbVarintField(3, stats.output),
    pbVarintField(4, stats.write ?? 0),
    pbVarintField(5, stats.read ?? 0),
    pbVarintField(9, stats.thinking ?? 0),
  );
  const chat = pbBytesField(4, usage);
  return pbBytesField(1, chat);
}

const USAGE_ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

afterEach(async () => {
  while (activeSchedulers.length > 0) {
    const sched = activeSchedulers.pop()!;
    try {
      await sched.closeAll("test_cleanup");
    } catch {}
    sched.destroy();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ===========================================================================
// 1. lostMedia historical media-stripping tolerance + coordinator e2e
// ===========================================================================

describe("Phase 3: lostMedia historical media-stripping tolerance", () => {
  const tinyPngB64 = Buffer.from(
    encodePngRgba(4, 4, makeSolidRgba(4, 4)),
  ).toString("base64");

  test("matches when earlier user image is removed or replaced with placeholder text", () => {
    const committed: NormalizedMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this screenshot" },
          { type: "image", mediaType: "image/png", data: tinyPngB64 },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "looks blue" }] },
    ];

    const strippedDrop: NormalizedMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "inspect this screenshot" }],
      },
      { role: "assistant", content: [{ type: "text", text: "looks blue" }] },
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ];

    expect(isPrefixMatch(committed, strippedDrop)).toBe(false);
    const res1 = matchLedgerPrefix(committed, strippedDrop);
    expect(res1).toEqual({
      matched: true,
      incomingPrefixLength: 2,
      viaLostMedia: true,
    });

    const strippedPlaceholder: NormalizedMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this screenshot" },
          { type: "text", text: "[image omitted from history]" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "looks blue" }] },
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ];
    expect(matchLedgerPrefix(committed, strippedPlaceholder)).toEqual({
      matched: true,
      incomingPrefixLength: 2,
      viaLostMedia: true,
    });
  });

  test("tolerates tool_result placeholder growth and dropped image-only user message using endMessageIndex + 1", () => {
    const committed: NormalizedMessage[] = [
      { role: "user", content: [{ type: "text", text: "read image tool" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_img",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            isError: false,
            content: [
              { type: "text", text: "ok" },
              { type: "image", mediaType: "image/png", data: tinyPngB64 },
            ],
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: tinyPngB64 }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    // Client strips the image from tool_result, appends a placeholder line,
    // drops the trailing image-only user message, and appends a new user turn.
    const incoming: NormalizedMessage[] = [
      { role: "user", content: [{ type: "text", text: "read image tool" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_img",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            isError: false,
            content: [{ type: "text", text: "ok\n[image stripped]" }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ];

    // incoming.length (5) === committed.length (5), yet the prefix ends at index 4!
    const match = matchLedgerPrefix(committed, incoming);
    expect(match).toEqual({
      matched: true,
      incomingPrefixLength: 4,
      viaLostMedia: true,
    });
    expect(incoming.slice(match.incomingPrefixLength)).toEqual([
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ]);

    // Dropping an image-only message shrinks incoming below committed when
    // ending in tool_result, yet must NOT be misclassified as compaction.
    const incomingAwaitingTool: NormalizedMessage[] = [
      { role: "user", content: [{ type: "text", text: "read image tool" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_img",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            isError: false,
            content: [{ type: "text", text: "ok\n[image stripped]" }],
          },
        ],
      },
    ];
    expect(
      isCompactedRequest(
        incomingAwaitingTool,
        committed.slice(0, 4),
        ["toolu_1"],
      ),
    ).toBe(false);
  });

  test("rejects changed plain text and sealed heardRuns remain zero-plaintext for persisted matching", () => {
    const committed: NormalizedMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "SECRET_USER_PROMPT" },
          { type: "image", mediaType: "image/png", data: tinyPngB64 },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "SECRET_REPLY" }] },
    ];

    const alteredText: NormalizedMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "DIFFERENT_PROMPT" }],
      },
      { role: "assistant", content: [{ type: "text", text: "SECRET_REPLY" }] },
    ];
    expect(matchLedgerPrefix(committed, alteredText)).toEqual({
      matched: false,
      incomingPrefixLength: 0,
      viaLostMedia: false,
    });

    const sealed = heardRuns(committed, true);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain("SECRET_USER_PROMPT");
    expect(serialized).not.toContain("SECRET_REPLY");
    expect(sealed[0]!.parts[0]!.words).toBeUndefined();

    const persistedMatch = matchPersistedPrefix(
      {
        messageDigests: digestMessagesForPersistence(committed),
        heardRuns: sealed,
      },
      [
        {
          role: "user",
          content: [{ type: "text", text: "SECRET_USER_PROMPT" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "SECRET_REPLY" }],
        },
        { role: "user", content: [{ type: "text", text: "turn 2" }] },
      ],
    );
    expect(persistedMatch).toEqual({
      matched: true,
      incomingPrefixLength: 2,
      viaLostMedia: true,
    });

    // Direct lostMedia sanity check
    expect(lostMedia(sealed, heardRuns(alteredText, false))).toEqual({
      matched: false,
      incomingPrefixLength: 0,
    });
  });

  test("SessionCoordinator reuses warm worker across stripped historical images without cold replay", async () => {
    const dataDir = makeTempDir("agy-lostmedia-e2e-");
    await withDataDir(dataDir, async () => {
      const scheduler = new GlobalScheduler({
        maxGlobalWorkers: 4,
        maxPerAccountWorkers: 4,
        idleTimeoutMs: 60_000,
      });
      activeSchedulers.push(scheduler);
      const coord = new SessionCoordinator({
        scheduler,
        mcpServer: getSharedMcpServer(),
        spawnFn: spawnFakeAcp,
      });
      const acct = makeAccount("lm");
      const sel: ModelSelection = {
        rawModelId: "gemini-3.8-flash",
        configModelValue: "gemini-3.8-flash",
      };
      const sessionId = `lm-sess-${Date.now()}`;
      const sessionKey = `${acct.slotKey}::${acct.accountRef}::${sessionId}`;

      const turn1: NormalizedAnthropicRequest = {
        model: "gemini-3.8-flash",
        system: "be helpful",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "TURN1_SECRET_LOOK" },
              { type: "image", mediaType: "image/png", data: tinyPngB64 },
            ],
          },
        ],
        tools: [],
        toolChoice: { type: "auto" },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };
      let ans1 = "";
      for await (const ev of coord.executeTurn(acct, turn1, sel)) {
        if (ev.type === "text_delta") ans1 += ev.text;
      }
      const worker1 = coord.getActiveWorker(sessionKey)!;
      expect(worker1).toBeDefined();
      const nativeId = worker1.nativeSessionId;

      // Turn 2 drops the earlier image and appends only a new user message.
      const turn2: NormalizedAnthropicRequest = {
        ...turn1,
        messages: [
          { role: "user", content: [{ type: "text", text: "TURN1_SECRET_LOOK" }] },
          { role: "assistant", content: [{ type: "text", text: ans1 }] },
          { role: "user", content: [{ type: "text", text: "TURN2_DELTA_ONLY" }] },
        ],
      };
      let ans2 = "";
      for await (const ev of coord.executeTurn(acct, turn2, sel)) {
        if (ev.type === "text_delta") ans2 += ev.text;
      }
      expect(coord.getActiveWorker(sessionKey)).toBe(worker1);
      expect(coord.getActiveWorker(sessionKey)!.nativeSessionId).toBe(nativeId);
      expect(ans2).toContain("TURN2_DELTA_ONLY");
      expect(ans2).not.toContain("TURN1_SECRET_LOOK");
      expect(ans2).not.toContain("<conversation_history>");
    });
  });
});

// ===========================================================================
// 2 & 3. Secondary content-hash lookup + MED-10 file-locked ShelfStore
// ===========================================================================

describe("Phase 3: MED-10 ShelfStore & secondary content-hash addressing", () => {
  function makeReq(
    messages: NormalizedMessage[],
    overrides: Partial<NormalizedAnthropicRequest> = {},
  ): NormalizedAnthropicRequest {
    return {
      model: "gemini-3.8-flash",
      system: "system instructions",
      messages,
      tools: [],
      toolChoice: { type: "auto" },
      stream: true,
      thinkingEnabled: false,
      sessionId: "sess-default",
      ...overrides,
    };
  }

  function makeSnapshot(
    overrides: Partial<WorkerParkSnapshot> = {},
  ): WorkerParkSnapshot {
    const acct = makeAccount("shelf");
    const committedMessages: NormalizedMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ];
    return {
      sessionId: "sess-1",
      nativeSessionId: `native-${crypto.randomUUID()}`,
      slotKey: acct.slotKey,
      accountRef: acct.accountRef,
      minimalAgent: false,
      workDir: "/tmp/proj",
      systemPrompt: "system instructions",
      registeredTools: [],
      committedMessages,
      resumeSupported: true,
      ...overrides,
    };
  }

  test("ShelfStore secondary lookup picks longest strict prefix and enforces all negative guards", () => {
    const dataDir = makeTempDir("agy-shelf-sec-");
    return withDataDir(dataDir, () => {
      const store = new ShelfStore();
      const acct = makeAccount("shelf");
      const now = 1_000_000;

      const msgU1: NormalizedMessage = {
        role: "user",
        content: [{ type: "text", text: "turn 1" }],
      };
      const msgA1: NormalizedMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ans 1" }],
      };
      const msgU2: NormalizedMessage = {
        role: "user",
        content: [{ type: "text", text: "turn 2" }],
      };
      const msgA2: NormalizedMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ans 2" }],
      };
      const msgU3: NormalizedMessage = {
        role: "user",
        content: [{ type: "text", text: "turn 3" }],
      };

      const shortKey = `${acct.slotKey}::${acct.accountRef}::old-short`;
      const longKey = `${acct.slotKey}::${acct.accountRef}::old-long`;
      store.park(
        shortKey,
        makeSnapshot({
          sessionId: "old-short",
          nativeSessionId: "native-short",
          committedMessages: [msgU1, msgA1],
        }),
        now,
      );
      store.park(
        longKey,
        makeSnapshot({
          sessionId: "old-long",
          nativeSessionId: "native-long",
          committedMessages: [msgU1, msgA1, msgU2, msgA2],
        }),
        now + 10,
      );

      const rotatedKey = `${acct.slotKey}::${acct.accountRef}::rotated-key`;
      const req = makeReq([msgU1, msgA1, msgU2, msgA2, msgU3], {
        sessionId: "rotated-key",
        workDir: "/tmp/proj",
      });

      // Longest strict prefix wins
      const hit = store.resolveResume({
        account: acct,
        req,
        sessionKey: rotatedKey,
        requestedMinimalAgent: false,
        now: now + 20,
        hasCustomSpawnFn: true,
      });
      expect(hit?.kind).toBe("memory");
      expect(hit?.viaSecondaryHash).toBe(true);
      expect(hit?.matchedKey).toBe(longKey);
      expect(hit?.matchedPrefixLength).toBe(4);
      expect(hit?.entry.nativeSessionId).toBe("native-long");

      // Busy key skipped -> falls back to shortKey
      const hitBusy = store.resolveResume({
        account: acct,
        req,
        sessionKey: rotatedKey,
        requestedMinimalAgent: false,
        now: now + 20,
        hasCustomSpawnFn: true,
        isKeyBusy: (k) => k === longKey,
      });
      expect(hitBusy?.matchedKey).toBe(shortKey);
      expect(hitBusy?.matchedPrefixLength).toBe(2);

      // toolChoice=none blocks secondary lookup
      expect(
        store.resolveResume({
          account: acct,
          req: makeReq([msgU1, msgA1, msgU2, msgA2, msgU3], {
            sessionId: "rotated-key",
            workDir: "/tmp/proj",
            toolChoice: { type: "none" },
          }),
          sessionKey: rotatedKey,
          requestedMinimalAgent: false,
          now: now + 20,
          hasCustomSpawnFn: true,
        }),
      ).toBeNull();

      // Whole-turn exact length (no new trailing user message) rejected for secondary lookup
      expect(
        store.resolveResume({
          account: acct,
          req: makeReq([msgU1, msgA1], {
            sessionId: "rotated-key",
            workDir: "/tmp/proj",
          }),
          sessionKey: rotatedKey,
          requestedMinimalAgent: false,
          now: now + 20,
          hasCustomSpawnFn: true,
        }),
      ).toBeNull();

      // Cross-account / cross-workDir / cross-subagent isolation
      const otherAcct = makeAccount("other");
      expect(
        store.resolveResume({
          account: otherAcct,
          req,
          sessionKey: `${otherAcct.slotKey}::${otherAcct.accountRef}::rotated-key`,
          requestedMinimalAgent: false,
          now: now + 20,
          hasCustomSpawnFn: true,
        }),
      ).toBeNull();
      expect(
        store.resolveResume({
          account: acct,
          req: makeReq([msgU1, msgA1, msgU2, msgA2, msgU3], {
            sessionId: "rotated-key",
            workDir: "/tmp/other-proj",
          }),
          sessionKey: rotatedKey,
          requestedMinimalAgent: false,
          now: now + 20,
          hasCustomSpawnFn: true,
        }),
      ).toBeNull();
      expect(
        store.resolveResume({
          account: acct,
          req: makeReq([msgU1, msgA1, msgU2, msgA2, msgU3], {
            sessionId: "rotated-key",
            workDir: "/tmp/proj",
            subagentId: "sub-1",
          }),
          sessionKey: `${rotatedKey}::sub:sub-1`,
          requestedMinimalAgent: false,
          now: now + 20,
          hasCustomSpawnFn: true,
        }),
      ).toBeNull();

      // HIGH-3: stale incompatible memory entry at exact sessionKey is deleted
      store.park(
        rotatedKey,
        makeSnapshot({
          sessionId: "rotated-key",
          nativeSessionId: "stale-native",
          workDir: "/tmp/wrong-dir",
        }),
        now,
      );
      expect(store.memorySessions.has(rotatedKey)).toBe(true);
      store.resolveResume({
        account: acct,
        req,
        sessionKey: rotatedKey,
        requestedMinimalAgent: false,
        now: now + 20,
        hasCustomSpawnFn: true,
      });
      expect(store.memorySessions.has(rotatedKey)).toBe(false);
    });
  });

  test("MED-10: 4 concurrent OS processes preserve all writes, cross-host sees invalidation, reclaims stale lock", async () => {
    const dataDir = makeTempDir("agy-shelf-mp-");
    const shelfPath = path.join(dataDir, SHELF_FILE_NAME);

    // Pre-create a stale dead-PID lock file to prove dead lock reclamation
    fs.writeFileSync(`${shelfPath}.lock`, "999999:dead-token\n", {
      mode: 0o600,
    });

    const workerScript = `
      import { ShelfStore } from ${JSON.stringify(path.resolve(REPO_ROOT, "src/sessions/shelf-store.ts"))};
      const procId = process.argv[1];
      if (!procId) throw new Error("missing procId");
      const store = new ShelfStore();
      for (let i = 0; i < 4; i++) {
        const sid = \`p\${procId}-s\${i}\`;
        const key = \`agy-acp#slot::acct::\${sid}\`;
        store.recordPersisted(key, {
          sessionId: sid,
          nativeSessionId: \`native-\${sid}\`,
          slotKey: "agy-acp#slot",
          accountRef: "acct",
          minimalAgent: false,
          systemPrompt: "TOP_SECRET_SYS_PROMPT",
          registeredTools: [{ name: "t", description: "SECRET_TOOL", inputSchema: { type: "object" } }],
          committedMessages: [
            { role: "user", content: [{ type: "text", text: \`SECRET_USER_\${sid}\` }] },
            { role: "assistant", content: [{ type: "text", text: \`SECRET_AI_\${sid}\` }] },
          ],
          resumeSupported: true,
        });
      }
    `;

    const children = Array.from({ length: 4 }, (_, idx) => {
      return new Promise<number>((resolve, reject) => {
        const child = spawn("bun", ["-e", workerScript, String(idx)], {
          cwd: REPO_ROOT,
          env: { ...process.env, AGY_ACP_DATA_DIR: dataDir },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`child ${idx} exited ${code}: ${stderr}`));
          else resolve(code);
        });
      });
    });

    await Promise.all(children);

    // All 16 entries survive, file mode 0o600, zero temp/lock residue, zero plaintext
    const raw = fs.readFileSync(shelfPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.sessions).length).toBe(16);
    expect(raw).not.toContain("SECRET_USER");
    expect(raw).not.toContain("SECRET_AI");
    expect(raw).not.toContain("TOP_SECRET_SYS_PROMPT");
    expect(raw).not.toContain("SECRET_TOOL");
    expect(fs.statSync(shelfPath).mode & 0o777).toBe(0o600);
    const dirEntries = fs.readdirSync(dataDir);
    expect(dirEntries).toEqual([SHELF_FILE_NAME]);

    // Cross-host mtime reload & invalidation + nativeId dedup
    await withDataDir(dataDir, () => {
      const hostA = new ShelfStore();
      const hostB = new ShelfStore();
      hostA.ensureLoaded();
      expect(hostA.persistedSessionsMap.size).toBe(16);

      // Re-keying native-p0-s0 under a new session key removes the old ghost key
      hostB.recordPersisted(
        "agy-acp#slot::acct::rekeyed",
        makeSnapshot({
          sessionId: "rekeyed",
          nativeSessionId: "native-p0-s0",
          slotKey: "agy-acp#slot",
          accountRef: "acct",
        }),
      );
      hostA.ensureLoaded();
      expect(hostA.persistedSessionsMap.has("agy-acp#slot::acct::p0-s0")).toBe(
        false,
      );
      expect(hostA.persistedSessionsMap.has("agy-acp#slot::acct::rekeyed")).toBe(
        true,
      );

      // Host B invalidates -> Host A observes immediately via mtime reload
      hostB.invalidate("agy-acp#slot::acct::p1-s1", "native-p1-s1");
      hostA.ensureLoaded();
      expect(hostA.persistedSessionsMap.has("agy-acp#slot::acct::p1-s1")).toBe(
        false,
      );
      expect(MAX_PARKED_SESSIONS).toBe(32);
      expect(MAX_PERSISTED_PARKED_SESSIONS).toBe(32);
      expect(MAX_SINGLE_PARKED_BYTES).toBe(4 * 1024 * 1024);
      expect(PARKED_SESSION_TTL_MS).toBe(6 * 60 * 60 * 1000);
    });
  });

  test("SessionCoordinator e2e adopts parked session across rotated sessionId via secondary hash", async () => {
    const dataDir = makeTempDir("agy-sec-e2e-");
    await withDataDir(dataDir, async () => {
      const scheduler = new GlobalScheduler({
        maxGlobalWorkers: 4,
        maxPerAccountWorkers: 4,
        idleTimeoutMs: 5,
      });
      activeSchedulers.push(scheduler);
      const coord = new SessionCoordinator({
        scheduler,
        mcpServer: getSharedMcpServer(),
        spawnFn: spawnFakeAcp,
      });
      const acct = makeAccount("sec");
      const sel: ModelSelection = {
        rawModelId: "gemini-3.8-flash",
        configModelValue: "gemini-3.8-flash",
      };

      const msg1: NormalizedMessage = {
        role: "user",
        content: [{ type: "text", text: "TURN1_CONTEXT_SEED" }],
      };
      let ans1 = "";
      for await (const ev of coord.executeTurn(
        acct,
        {
          model: "gemini-3.8-flash",
          system: "stable sys",
          messages: [msg1],
          tools: [],
          toolChoice: { type: "auto" },
          stream: true,
          thinkingEnabled: false,
          sessionId: "orig-session-id",
        },
        sel,
      )) {
        if (ev.type === "text_delta") ans1 += ev.text;
      }

      const origWorker = coord.getActiveWorker(
        `${acct.slotKey}::${acct.accountRef}::orig-session-id`,
      )!;
      const origNativeId = origWorker.nativeSessionId;
      origWorker.lastActivityAt = Date.now() - 10_000;
      expect(await scheduler.reapIdleWorkers()).toBe(1);

      let ans2 = "";
      for await (const ev of coord.executeTurn(
        acct,
        {
          model: "gemini-3.8-flash",
          system: "stable sys",
          messages: [
            msg1,
            { role: "assistant", content: [{ type: "text", text: ans1 }] },
            {
              role: "user",
              content: [{ type: "text", text: "INSPECT_RESUME TURN2_AFTER_ROTATION" }],
            },
          ],
          tools: [],
          toolChoice: { type: "auto" },
          stream: true,
          thinkingEnabled: false,
          sessionId: "rotated-session-id",
        },
        sel,
      )) {
        if (ev.type === "text_delta") ans2 += ev.text;
      }

      const resumedWorker = coord.getActiveWorker(
        `${acct.slotKey}::${acct.accountRef}::rotated-session-id`,
      )!;
      expect(resumedWorker).toBeDefined();
      expect(resumedWorker.resumedFromShelf).toBe(true);
      expect(resumedWorker.nativeSessionId).toBe(origNativeId);
      expect(ans2).toContain(`[resumedSessionId=${origNativeId}]`);
      expect(ans2).toContain("TURN2_AFTER_ROTATION");
      expect(ans2).not.toContain("<conversation_history>");
    });
  });
});

// ===========================================================================
// 4. Inline image fitting & wiring (images.ts, broker.ts, prompt-render.ts)
// ===========================================================================

describe("Phase 3: inline image fitting & broker/prompt-render wiring", () => {
  test("readImageDimensions handles PNG, JPEG, GIF, WebP and rejects invalid input", () => {
    const png = encodePngRgba(17, 9, makeSolidRgba(17, 9));
    expect(readImageDimensions(png)).toEqual({
      width: 17,
      height: 9,
      format: "png",
    });

    const jpeg = encodeJpegRgba(23, 13, makeSolidRgba(23, 13), 80);
    expect(readImageDimensions(jpeg)).toEqual({
      width: 23,
      height: 13,
      format: "jpeg",
    });

    // Minimal valid GIF89a header
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2a, 0x00, 0x15, 0x00, 0x00, 0x00,
      0x00,
    ]);
    expect(readImageDimensions(gif)).toEqual({
      width: 42,
      height: 21,
      format: "gif",
    });

    // WebP VP8X container (width - 1 = 3000 - 1 = 2999 = 0x000BB7, height - 1 = 1500 - 1 = 1499 = 0x0005DB)
    const vp8x = new Uint8Array(30);
    vp8x.set(Buffer.from("RIFF"), 0);
    vp8x.set([22, 0, 0, 0], 4);
    vp8x.set(Buffer.from("WEBP"), 8);
    vp8x.set(Buffer.from("VP8X"), 12);
    vp8x.set([10, 0, 0, 0], 16);
    vp8x[24] = 0xb7;
    vp8x[25] = 0x0b;
    vp8x[26] = 0x00;
    vp8x[27] = 0xdb;
    vp8x[28] = 0x05;
    vp8x[29] = 0x00;
    expect(readImageDimensions(vp8x)).toEqual({
      width: 3000,
      height: 1500,
      format: "webp",
    });

    expect(readImageDimensions(Buffer.from("AAAA", "base64"))).toBeNull();
  });

  test("lossless/arithmetic JPEG (SOF3/SOF9) is probed but never decoded or re-encoded", () => {
    // Only baseline (SOF0), extended sequential (SOF1) and progressive (SOF2)
    // Huffman frames are decodable here. A lossless (SOF3) or arithmetic-coded
    // (SOF9) frame must come back as `null` instead of being decoded to garbage
    // and then re-encoded over the caller's real pixels.
    const frameHeader = (
      sofMarker: number,
      width: number,
      height: number,
    ): Uint8Array =>
      Uint8Array.from([
        0xff, 0xd8, // SOI
        0xff, sofMarker, 0x00, 0x0b, // frame header, length 11
        0x08, // 8-bit precision
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x01, // one component
        0x01, 0x11, 0x00, // id 1, 1x1 sampling, quant table 0
        0xff, 0xd9, // EOI
      ]);

    for (const sofMarker of [0xc3, 0xc9]) {
      const header = frameHeader(sofMarker, 32, 16);
      const base64 = Buffer.from(header).toString("base64");
      // Probing reads only the frame header, so the dimensions are still known.
      expect(readImageDimensions(header)).toEqual({
        width: 32,
        height: 16,
        format: "jpeg",
      });
      expect(decodeImageRgba(header)).toBeNull();
      expect(fitInlineImage("image/jpeg", base64)).toEqual({
        mediaType: "image/jpeg",
        data: base64,
      });

      // Wider than `MAX_INLINE_IMAGE_SIDE`, so the fitter really does attempt a
      // decode + downscale: the undecodable frame must still pass through the
      // original bytes rather than becoming a grey re-encoded JPEG.
      const wide = frameHeader(sofMarker, MAX_INLINE_IMAGE_SIDE + 400, 16);
      const wideBase64 = Buffer.from(wide).toString("base64");
      expect(decodeImageRgba(wide)).toBeNull();
      expect(fitInlineImage("image/jpeg", wideBase64)).toEqual({
        mediaType: "image/jpeg",
        data: wideBase64,
      });
    }
  });

  test("fast path, downscale (>2000px), LRU cache, WebP downscale/passthrough, and bomb guard", () => {
    // 1. Small/unreadable passthrough untouched
    expect(fitInlineImage("image/png", "AAAA")).toEqual({
      mediaType: "image/png",
      data: "AAAA",
    });
    const smallB64 = Buffer.from(
      encodePngRgba(32, 24, makeSolidRgba(32, 24)),
    ).toString("base64");
    const smallOut = fitInlineImage("image/png", smallB64);
    expect(smallOut.mediaType).toBe("image/png");
    expect(smallOut.data).toBe(smallB64);

    // 2. Oversized PNG (2400x1200) -> 2000x1000 PNG <= 5 MiB base64
    const bigPng = encodePngRgba(2400, 1200, makeSolidRgba(2400, 1200, 10, 200, 30));
    const bigPngB64 = Buffer.from(bigPng).toString("base64");
    const fittedPng = fitInlineImage("image/png", bigPngB64);
    expect(fittedPng.mediaType).toBe("image/png");
    expect(fittedPng.data.length).toBeLessThanOrEqual(MAX_INLINE_IMAGE_BASE64_BYTES);
    const fittedPngBytes = Buffer.from(fittedPng.data, "base64");
    expect(readImageDimensions(fittedPngBytes)).toEqual({
      width: MAX_INLINE_IMAGE_SIDE,
      height: 1000,
      format: "png",
    });
    const decodedPng = decodeImageRgba(fittedPngBytes);
    expect(decodedPng?.width).toBe(2000);
    expect(decodedPng?.height).toBe(1000);
    // LRU cache hit produces identical object
    expect(getFittedImageCacheSize()).toBeGreaterThanOrEqual(1);
    expect(fitInlineImage("image/png", bigPngB64)).toEqual(fittedPng);

    // 3. Oversized JPEG (2400x1200) -> 2000x1000 JPEG
    const bigJpeg = encodeJpegRgba(
      2400,
      1200,
      makeSolidRgba(2400, 1200, 220, 40, 40),
      85,
    );
    const bigJpegB64 = Buffer.from(bigJpeg).toString("base64");
    const fittedJpeg = fitInlineImage("image/jpeg", bigJpegB64);
    expect(fittedJpeg.mediaType).toBe("image/jpeg");
    expect(
      readImageDimensions(Buffer.from(fittedJpeg.data, "base64")),
    ).toEqual({
      width: 2000,
      height: 1000,
      format: "jpeg",
    });

    // 4. Forged PNG header exceeding MAX_DECODE_HOLD_BYTES (256 MiB) -> passthrough
    const bombPng = encodePngRgba(4, 4, makeSolidRgba(4, 4));
    const bombCopy = new Uint8Array(bombPng);
    const view = new DataView(bombCopy.buffer, bombCopy.byteOffset, bombCopy.byteLength);
    view.setUint32(16, 10_000, false);
    view.setUint32(20, 10_000, false); // 10k * 10k * 4 = 400 MB > 256 MB
    expect(bombCopy.length + 10_000 * 10_000 * 4).toBeGreaterThan(
      MAX_DECODE_HOLD_BYTES,
    );
    const bombB64 = Buffer.from(bombCopy).toString("base64");
    expect(fitInlineImage("image/png", bombB64)).toEqual({
      mediaType: "image/png",
      data: bombB64,
    });

    // 5. Noisy >5 MiB PNG (<=2000px, e.g. 1600x1200 raw noise) triggers JPEG fallback cascade
    const noisyPng = encodePngRgba(1600, 1200, makeNoisyRgba(1600, 1200));
    const noisyB64 = Buffer.from(noisyPng).toString("base64");
    expect(noisyB64.length).toBeGreaterThan(MAX_INLINE_IMAGE_BASE64_BYTES);
    const fittedNoisy = fitInlineImage("image/png", noisyB64);
    expect(fittedNoisy.mediaType).toBe("image/jpeg");
    expect(fittedNoisy.data.length).toBeLessThanOrEqual(
      MAX_INLINE_IMAGE_BASE64_BYTES,
    );

    // 6. Truncated/chunkless VP8X WebP passes through safely, while valid oversized WebP downscales
    const vp8x = new Uint8Array(30);
    vp8x.set(Buffer.from("RIFF"), 0);
    vp8x.set([22, 0, 0, 0], 4);
    vp8x.set(Buffer.from("WEBP"), 8);
    vp8x.set(Buffer.from("VP8X"), 12);
    vp8x.set([10, 0, 0, 0], 16);
    vp8x[24] = 0xb7;
    vp8x[25] = 0x0b; // width = 3000
    vp8x[27] = 0xdb;
    vp8x[28] = 0x05; // height = 1500
    const webpB64 = Buffer.from(vp8x).toString("base64");
    expect(fitInlineImage("image/webp", webpB64)).toEqual({
      mediaType: "image/webp",
      data: webpB64,
    });

    const bigWebpB64 =
      "UklGRrIAAABXRUJQVlA4TKUAAAAvX8krEQ9QqJPAHwX5gf9RgUzaZv5Nz0HfRPR/Ah51UfmP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iP//iPWgAA";
    const fittedWebp = fitInlineImage("image/webp", bigWebpB64);
    expect(fittedWebp.mediaType).toBe("image/png");
    const fittedWebpPng = decodeImageRgba(Buffer.from(fittedWebp.data, "base64"));
    expect(fittedWebpPng?.width).toBe(2000);
    expect(fittedWebpPng?.height).toBe(1000);
    // Left half had alpha=128, right half had alpha=255
    expect(fittedWebpPng?.rgba[3]).toBe(128);
    expect(fittedWebpPng?.rgba[(1999) * 4 + 3]).toBe(255);
  });

  test("decodeWebp and fitInlineImage cover VP8L, VP8, VP8X+ALPH, animation passthrough, noisy JPEG fallback, and budget guards", () => {
    const sha256Hex = (bytes: Uint8Array): string =>
      crypto.createHash("sha256").update(bytes).digest("hex");

    // 1. VP8L lossless (19x13 spatial/color/subtract-green/color-cache/alpha) — 0-bit diff vs dwebp
    const vp8lRaw = Buffer.from(
      "UklGRkYAAABXRUJQVlA4TDkAAAAvEgADELkKRPQ/dlGH6H/ASNtIaApq4vybfPhUSJBiG0mBQJI/4xQTCASSVSNbtQcr/X29M4zgvwAA",
      "base64",
    );
    const vp8lDec = decodeWebp(vp8lRaw);
    expect(vp8lDec?.width).toBe(19);
    expect(vp8lDec?.height).toBe(13);
    expect(sha256Hex(vp8lDec!.rgba)).toBe(
      "d2ef07c708383883fa3012b21259f41ae259ed8d4a5279a9e7f230e876fea68f",
    );

    // 2. VP8L lossless palette (11x9 7-color packed widthBits=1 + alpha) — 0-bit diff vs dwebp
    const vp8lPalRaw = Buffer.from(
      "UklGRmAAAABXRUJQVlA4TFQAAAAvCgACEDcgECD850mwYmJGpkcgkGQw+soJ/G6wjWSrrSx9/odYrgJc7HNfgKiASBH9Dxf1jmx9wmwCrPyE5nTWzI/XSdiydIs4zJX5mGYdouCZfwQ=",
      "base64",
    );
    const vp8lPalDec = decodeWebp(vp8lPalRaw);
    expect(vp8lPalDec?.width).toBe(11);
    expect(vp8lPalDec?.height).toBe(9);
    expect(sha256Hex(vp8lPalDec!.rgba)).toBe(
      "51e68fce6c327f50a2dbef04fd67e74d5d0aaa7523d6a3eb15e5c3705dbce642",
    );

    // 3. VP8 lossy keyframe (17x15) — exact pixel match vs dwebp
    const vp8Raw = Buffer.from(
      "UklGRmgAAABXRUJQVlA4IFwAAAAQBACdASoRAA8APm0skkWkIqGYBABABsS1AE6ZQjgPcAAszmJ/mU7BQAD+ozRRvxnjc/SrOwiEd5zuI3/5ciSbLukfLJg2f/1C8bYC6kh9zVE6DkueWiRotQgAAA==",
      "base64",
    );
    const vp8Dec = decodeWebp(vp8Raw);
    expect(vp8Dec?.width).toBe(17);
    expect(vp8Dec?.height).toBe(15);
    expect(sha256Hex(vp8Dec!.rgba)).toBe(
      "385407d49a4e38381abaca59fc5c8b80374d6c9c9136eeaa9d15f09e6a060115",
    );

    // 4. VP8X + ALPH extended still (16x16 compressed + gradient-filtered alpha) — exact match vs dwebp
    const vp8xAlphRaw = Buffer.from(
      "UklGRpAAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSBcAAAABuQpE9D+gtG0Dpmz+f3NhacQEJNaiuwBWUDggUgAAADACAJ0BKhAAEAABQCYlsAJ0ugADO5Rju9VgAP79YIwDvanxHSNbNMlxOm4HTWIyTvY7RIcP/XJmpPtH3ii3PezqTv98Ef3C9/P+tPzh5/mMAAA=",
      "base64",
    );
    const vp8xAlphDec = decodeWebp(vp8xAlphRaw);
    expect(vp8xAlphDec?.width).toBe(16);
    expect(vp8xAlphDec?.height).toBe(16);
    expect(sha256Hex(vp8xAlphDec!.rgba)).toBe(
      "4aa8b0e450c8a6690e9cb12d5c66c9f9b26f324f0b06b9f2eaa211601ace7ac3",
    );
    expect(decodeImageRgba(vp8xAlphRaw)?.rgba).toEqual(vp8xAlphDec!.rgba);

    // 5. Oversized noisy WebP (2004x1200) -> PNG exceeds 5 MiB -> falls back to image/jpeg
    const encodeUncompressedVp8lWebp = (w: number, h: number, rgba: Uint8Array): Uint8Array => {
      const rev8 = new Uint8Array(256);
      for (let i = 0; i < 256; i += 1) {
        let v = i, r = 0;
        for (let b = 0; b < 8; b += 1) { r = (r << 1) | (v & 1); v >>>= 1; }
        rev8[i] = r;
      }
      const bits: number[] = [];
      const push = (val: number, n: number): void => {
        for (let i = 0; i < n; i += 1) bits.push((val >>> i) & 1);
      };
      push(w - 1, 14); push(h - 1, 14); push(0, 1); push(0, 3);
      push(0, 1); push(0, 1); push(0, 1); // no transform, no cache, no meta
      // G, R, B: normal Huffman where symbols 0..255 all have length 8 (clLengths[8] = 1, max_symbol = 256)
      for (let ch = 0; ch < 3; ch += 1) {
        push(0, 1); // normal
        push(8, 4); // numCodeLengths = 12 (covers index 11 -> codeLen 8)
        for (let k = 0; k < 12; k += 1) push(k === 11 ? 1 : 0, 3);
        push(1, 1); push(3, 3); push(254, 8); // length_nbits=8, max_symbol = 2 + 254 = 256
      }
      push(1, 1); push(0, 1); push(1, 1); push(255, 8); // A = 255
      push(1, 1); push(0, 1); push(0, 1); push(0, 1); // Dist = 0
      const headerByteLen = 1 + Math.ceil(bits.length / 8);
      // Pad to byte boundary? No, emit packed bits directly via small byte writer:
      const totalBits = bits.length + w * h * 24;
      const vp8lPayload = new Uint8Array(1 + Math.ceil(totalBits / 8));
      vp8lPayload[0] = 0x2f;
      let bitPos = 0;
      for (let i = 0; i < bits.length; i += 1) {
        if (bits[i]!) vp8lPayload[1 + (bitPos >> 3)]! |= 1 << (bitPos & 7);
        bitPos += 1;
      }
      for (let p = 0; p < w * h; p += 1) {
        const g = rev8[rgba[p * 4 + 1]!]!;
        const r = rev8[rgba[p * 4]!]!;
        const b = rev8[rgba[p * 4 + 2]!]!;
        const trio = g | (r << 8) | (b << 16);
        const byteIdx = 1 + (bitPos >> 3);
        const shift = bitPos & 7;
        vp8lPayload[byteIdx]! |= (trio << shift) & 0xff;
        vp8lPayload[byteIdx + 1]! |= (trio >>> (8 - shift)) & 0xff;
        vp8lPayload[byteIdx + 2]! |= (trio >>> (16 - shift)) & 0xff;
        if (shift > 0) vp8lPayload[byteIdx + 3]! |= (trio >>> (24 - shift)) & 0xff;
        bitPos += 24;
      }
      void headerByteLen;
      const pad = vp8lPayload.length & 1;
      const riffSize = 12 + vp8lPayload.length + pad;
      const out = new Uint8Array(8 + riffSize);
      out.set(Buffer.from("RIFF"), 0);
      new DataView(out.buffer).setUint32(4, riffSize, true);
      out.set(Buffer.from("WEBP"), 8);
      out.set(Buffer.from("VP8L"), 12);
      new DataView(out.buffer).setUint32(16, vp8lPayload.length, true);
      out.set(vp8lPayload, 20);
      return out;
    };

    const noisyWebp = encodeUncompressedVp8lWebp(2004, 1200, makeNoisyRgba(2004, 1200));
    const noisyWebpB64 = Buffer.from(noisyWebp).toString("base64");
    const fittedNoisyWebp = fitInlineImage("image/webp", noisyWebpB64);
    expect(fittedNoisyWebp.mediaType).toBe("image/jpeg");
    expect(fittedNoisyWebp.data.length).toBeLessThanOrEqual(MAX_INLINE_IMAGE_BASE64_BYTES);
    expect(readImageDimensions(Buffer.from(fittedNoisyWebp.data, "base64"))).toEqual({
      width: 2000,
      height: 1198,
      format: "jpeg",
    });

    // 6. Animated VP8X (animation flag 0x02 + ANMF chunk) passes through byte-for-byte
    const animChunkPayload = new Uint8Array(16); // minimal ANMF header
    const animRiffSize = 4 + 18 + 8 + animChunkPayload.length;
    const animWebp = new Uint8Array(8 + animRiffSize);
    animWebp.set(Buffer.from("RIFF"), 0);
    new DataView(animWebp.buffer).setUint32(4, animRiffSize, true);
    animWebp.set(Buffer.from("WEBP"), 8);
    animWebp.set(Buffer.from("VP8X"), 12);
    new DataView(animWebp.buffer).setUint32(16, 10, true);
    animWebp[20] = 0x02; // animation flag
    animWebp[24] = 0xb7; animWebp[25] = 0x0b; // width = 3000
    animWebp[27] = 0xdb; animWebp[28] = 0x05; // height = 1500
    animWebp.set(Buffer.from("ANMF"), 30);
    new DataView(animWebp.buffer).setUint32(34, animChunkPayload.length, true);
    expect(decodeWebp(animWebp)).toBeNull();
    const animB64 = Buffer.from(animWebp).toString("base64");
    expect(fitInlineImage("image/webp", animB64)).toEqual({
      mediaType: "image/webp",
      data: animB64,
    });

    // 7. Truncated, corrupted, and maxHoldBytes-exceeding WebP inputs return null without throwing
    expect(decodeWebp(vp8lRaw.subarray(0, vp8lRaw.length - 10))).toBeNull();
    expect(decodeWebp(vp8Raw.subarray(0, 25))).toBeNull();
    expect(decodeWebp(vp8lRaw, 512)).toBeNull(); // raw + ARGB/RGBA buffers exceed 512-byte budget

    const forgedBombWebp = new Uint8Array(vp8xAlphRaw);
    forgedBombWebp[24] = 0x0f; forgedBombWebp[25] = 0x27; forgedBombWebp[26] = 0x00; // width = 10000
    forgedBombWebp[27] = 0x0f; forgedBombWebp[28] = 0x27; forgedBombWebp[29] = 0x00; // height = 10000
    const forgedBombB64 = Buffer.from(forgedBombWebp).toString("base64");
    expect(fitInlineImage("image/webp", forgedBombB64)).toEqual({
      mediaType: "image/webp",
      data: forgedBombB64,
    });
  });

  test("an oversized raw turn is refused, not clipped; a framed compaction is trimmed", () => {
    // Clipping the middle of the caller's own text loses instructions the model
    // then never receives, while the ledger records the whole request and later
    // turns believe the model read it. A client's compaction request is framed in
    // `<conversation>` and is meant to be trimmed.
    const big = "x".repeat(140 * 1024);
    let thrown: unknown;
    try {
      renderMessagesToPrompt([], [
        { role: "user", content: [{ type: "text", text: big }] },
      ]);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { status?: number } | undefined)?.status).toBe(400);
    expect(String((thrown as { message?: string } | undefined)?.message)).toBe(
      CONTEXT_BUDGET_FAILURE_MESSAGE,
    );
    expect(String((thrown as { message?: string } | undefined)?.message)).toMatch(
      /prompt is too long/i,
    );

    const framed = renderMessagesToPrompt([], [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<conversation>\n${big}\n</conversation>\n\nSummarize the above.`,
          },
        ],
      },
    ]);
    expect(JSON.stringify(framed)).toContain("truncated middle for prompt budget");
  });

  test("a cold-plan seed rewords user text, since the seed is sent as system text", () => {
    // The seed only carries the turns the prompt budget pushes out, so the Codex
    // line goes in the oldest one and the rest is filler.
    const filler = "y".repeat(4 * 1024);
    const prior: any[] = [
      { role: "user", content: [{ type: "text", text: "You are Codex, an agent based on GPT-5." }] },
    ];
    for (let i = 0; i < 40; i += 1) {
      prior.push({ role: "assistant", content: [{ type: "text", text: filler }] });
      prior.push({ role: "user", content: [{ type: "text", text: `turn ${i}` }] });
    }
    const current = [{ role: "user", content: [{ type: "text", text: "next" }] }] as any;

    const cloaked = planColdHistoryRender(prior, current, "gemini-4-carbon", 0, true)
      .systemHistorySeed;
    expect(cloaked).toBeDefined();
    expect(cloaked).toContain("an agent built on GPT-5");

    const plain = planColdHistoryRender(prior, current, "gemini-4-carbon", 0, false)
      .systemHistorySeed;
    expect(plain).toContain("an agent based on GPT-5");
  });

  test("SessionToolBroker and renderMessagesToPrompt pass inline images through fitInlineImage", async () => {
    const bigPng = encodePngRgba(2400, 1200, makeSolidRgba(2400, 1200, 50, 90, 200));
    const bigB64 = Buffer.from(bigPng).toString("base64");

    // 1. renderMessagesToPrompt fits both direct image and tool_result image
    const promptParts = renderMessagesToPrompt(
      [
        {
          role: "user",
          content: [{ type: "image", mediaType: "image/png", data: bigB64 }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "snap", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              isError: false,
              content: [{ type: "image", mediaType: "image/png", data: bigB64 }],
            },
          ],
        },
      ],
      [{ role: "user", content: [{ type: "text", text: "describe" }] }],
    );
    const imgParts = promptParts.filter(
      (p): p is { type: "image"; data: string; mimeType: string } =>
        p.type === "image",
    );
    expect(imgParts.length).toBe(2);
    for (const part of imgParts) {
      expect(readImageDimensions(Buffer.from(part.data, "base64"))).toEqual({
        width: 2000,
        height: 1000,
        format: "png",
      });
    }

    // 2. SessionToolBroker fits tool_result image and leaves "AAAA" untouched
    let resolveBatch!: (calls: any[]) => void;
    const exposedPromise = new Promise<any[]>((resolve) => {
      resolveBatch = resolve;
    });
    const broker = new SessionToolBroker({
      batchWindowMs: 1,
      onBatchReady: (calls) => resolveBatch(calls),
    });
    broker.setTools([{ name: "snap", inputSchema: { type: "object" } }]);
    broker.openTurnWindow();

    const rpcPromise = broker.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "snap", arguments: {} },
    });
    const exposed = await exposedPromise;
    expect(exposed.length).toBe(1);

    broker.deliverToolResults([
      {
        toolUseId: exposed[0]!.id,
        isError: false,
        content: [
          { type: "image", mediaType: "image/png", data: bigB64 },
          { type: "image", mediaType: "image/png", data: "AAAA" },
        ],
      },
    ]);
    const rpcRes: any = await rpcPromise;
    expect(rpcRes.status).toBe(200);
    expect(rpcRes.body.result.content[0].type).toBe("image");
    expect(
      readImageDimensions(
        Buffer.from(rpcRes.body.result.content[0].data, "base64"),
      ),
    ).toEqual({
      width: 2000,
      height: 1000,
      format: "png",
    });
    expect(rpcRes.body.result.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    });
  });
});

// ===========================================================================
// 5. ARCH-2: TurnContext, StepUsageTracker, worker.pin(), scheduler hooks
// ===========================================================================

describe("Phase 3: ARCH-2 TurnContext, StepUsageTracker, worker.pin(), scheduler hooks", () => {
  test("TurnContext epochs, thinking accumulation, overflow-safe finishWith, takeQueue", async () => {
    expect(DEFAULT_MAX_TURN_QUEUE_BYTES).toBe(16 * 1024 * 1024);
    const tc = new TurnContext();

    const e1 = tc.nextPromptEpoch();
    const e2 = tc.nextPromptEpoch();
    expect(e1).toBe(1);
    expect(e2).toBe(2);
    expect(tc.isSuppressedOrStale(e1)).toBe(true);
    expect(tc.isSuppressedOrStale(e2)).toBe(false);

    tc.suppressingSteerCancel = true;
    expect(tc.isSuppressedOrStale(e2)).toBe(true);
    tc.suppressingSteerCancel = false;

    let overflows = 0;
    const q = tc.beginTurnQueue({
      maxBufferedBytes: 512,
      onOverflow: () => {
        overflows += 1;
      },
    });
    expect(tc.queueOpen).toBe(true);
    tc.heldText = "old-held";
    tc.appendThinking("thought-1");
    expect(tc.consumeThinkingForSignature()).toBe("thought-1");
    expect(tc.thinkingText).toBe("");

    // Calling finishWith clears activeQueue before pushing even on overflow
    tc.finishWith({
      type: "text_delta",
      text: "z".repeat(2048),
    });
    expect(tc.activeQueue).toBeNull();
    expect(tc.queueOpen).toBe(false);
    expect(overflows).toBe(1);
    await expect(q.next()).rejects.toThrow(/maximum capacity/i);

    // takeQueue transfers ownership cleanly; failQueue propagates error
    const q2 = tc.beginTurnQueue({ onOverflow: () => {} });
    const taken = tc.takeQueue();
    expect(taken).toBe(q2);
    expect(tc.activeQueue).toBeNull();
    q2.close();

    const q3 = tc.beginTurnQueue({ onOverflow: () => {} });
    tc.failQueue(new Error("boom"));
    expect(tc.activeQueue).toBeNull();
    await expect(q3.next()).rejects.toThrow("boom");
    expect(AsyncEventQueue).toBeDefined();
  });

  test("ACP prompt usage is authoritative: subtracted from batch reports, and the rows skipped", async () => {
    const convDir = makeTempDir("agy-tracker-acp-");
    await withConversationsDir(convDir, () => {
      const acct = makeAccount("acp");
      const nativeId = "conv-acp-1";
      const dbPath = path.join(convDir, `${nativeId}.db`);
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL;");
      db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
      const insert = db.prepare(
        "INSERT INTO gen_metadata (idx, data) VALUES (?, ?)",
      );
      insert.run(0, encodeGenMetadataBlob({ input: 100, output: 20, read: 50 }));

      const tracker = new StepUsageTracker();
      // The prompt result states the turn's whole usage, tool steps included.
      expect(
        usageFromAcpPromptResult({
          inputTokens: 8886,
          outputTokens: 30,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          thoughtTokens: 29,
          totalTokens: 8916,
        }),
      ).toEqual({
        inputTokens: 8886,
        outputTokens: 30,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      // No usage at all means "the agent said nothing", so the rows keep deciding.
      expect(usageFromAcpPromptResult(undefined)).toBeNull();
      expect(usageFromAcpPromptResult({ stopReason: "end_turn" })).toBeNull();

      // A tool batch already reported 60/10/0 this turn.
      tracker.noteTurnReported({
        inputTokens: 60,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      const settled = tracker.settlePromptTurnFromAcp(acct, nativeId, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 0,
      });
      expect(settled).toEqual({
        inputTokens: 40,
        outputTokens: 10,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 0,
      });

      // The row that was already accounted for must never surface as the next
      // turn's work: this is the delayed-WAL double count.
      expect(tracker.readUnseenStepsSync(acct, nativeId)).toEqual([]);
      expect(tracker.lastStepIdx).toBe(0);

      // A second turn's own row still reports normally.
      insert.run(1, encodeGenMetadataBlob({ input: 300, output: 40 }));
      const next = tracker.readUnseenStepsSync(acct, nativeId);
      expect(next.map((s) => s.idx)).toEqual([1]);
      expect(next[0]?.input).toBe(300);
    });
  });

  test("StepUsageTracker advances cursor on SQLite DB and avoids double-counting suppressed steers", async () => {
    const convDir = makeTempDir("agy-tracker-db-");
    await withConversationsDir(convDir, () => {
      const acct = makeAccount("trk");
      const nativeId = "conv-tracker-1";
      const dbPath = path.join(convDir, `${nativeId}.db`);
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL;");
      db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
      const insertStmt = db.prepare(
        "INSERT INTO gen_metadata (idx, data) VALUES (?, ?)",
      );
      insertStmt.run(
        0,
        encodeGenMetadataBlob({ input: 100, output: 20, read: 50 }),
      );

      const tracker = new StepUsageTracker();
      // 1. Report step 0 on normal prompt turn
      const settled0 = tracker.settlePromptTurn(acct, nativeId, {
        inputTokens: 999,
        outputTokens: 999,
      });
      expect(settled0).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 0,
      });
      expect(tracker.lastStepIdx).toBe(0);

      // 2. Steer cancels and gets suppressed WITHOUT a new SQLite row for step 1:
      //    bankSuppressedPromptTurn must NOT re-count already-reported step 0!
      tracker.bankSuppressedPromptTurn(acct, nativeId, {
        inputTokens: 12,
        outputTokens: 3,
      });
      const drained = tracker.drainWithUnreported({
        inputTokens: 5,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      expect(drained).toEqual({
        inputTokens: 17,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });

      // 3. New SQLite row idx=1 arrives; syncExistingConversation skips it cleanly
      insertStmt.run(
        1,
        encodeGenMetadataBlob({ input: 300, output: 40, read: 10 }),
      );
      insertStmt.finalize();
      db.close();

      expect(tracker.readUnseenStepsSync(acct, nativeId).map((s) => s.idx)).toEqual([
        1,
      ]);
      expect(tracker.lastStepIdx).toBe(1);

      const trackerResumed = new StepUsageTracker();
      trackerResumed.syncExistingConversation(acct, nativeId);
      expect(trackerResumed.lastStepIdx).toBe(1);
    });
  });

  test("worker.pin() ref-counted leases and GlobalScheduler typed lifecycle hooks", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 1,
      maxPerAccountWorkers: 1,
      idleTimeoutMs: 5,
    });
    activeSchedulers.push(scheduler);
    const acct = makeAccount("pin");

    let evictHookCalls = 0;
    let tickHookCalls = 0;
    const seenWorkers: string[] = [];

    const unregEvictThrow = scheduler.addBeforeEvictIdleHook(() => {
      throw new Error("hook 1 boom");
    });
    const unregEvictOk = scheduler.addBeforeEvictIdleHook((w) => {
      evictHookCalls += 1;
      seenWorkers.push(w.sessionId);
    });
    const unregTickThrow = scheduler.addReapTickHook(() => {
      throw new Error("tick boom");
    });
    const unregTickOk = scheduler.addReapTickHook(() => {
      tickHookCalls += 1;
    });

    const worker1 = new AgySessionWorker(acct, "w1", getSharedMcpServer(), {
      spawnFn: spawnFakeAcp,
    });
    await scheduler.reserveAndRegister(worker1);
    await worker1.start();

    // Nested/overlapping pin leases
    const releaseA = worker1.pin();
    const releaseB = worker1.pin();
    expect(worker1.pinned).toBe(true);

    // While leased, evictIdleLRU cannot evict worker1
    worker1.lastActivityAt = Date.now() - 10_000;
    expect(await scheduler.reapIdleWorkers()).toBe(0);
    expect(tickHookCalls).toBe(1);

    // Releasing first lease (twice for idempotency) keeps worker1 pinned
    releaseA();
    releaseA();
    expect(worker1.pinned).toBe(true);
    expect(await scheduler.reapIdleWorkers()).toBe(0);

    // Releasing final lease unpins worker1 so eviction & hooks fire
    releaseB();
    expect(worker1.pinned).toBe(false);
    expect(await scheduler.reapIdleWorkers()).toBe(1);
    expect(evictHookCalls).toBe(1);
    expect(seenWorkers).toEqual(["w1"]);

    // Unregister is idempotent and suppresses further calls
    expect(tickHookCalls).toBe(3);
    unregEvictThrow();
    unregEvictThrow();
    unregEvictOk();
    unregTickThrow();
    unregTickOk();
    await scheduler.reapIdleWorkers();
    expect(tickHookCalls).toBe(3); // did not increment to 4
  });
});

// ===========================================================================
// 6. ARCH-3: encodeAnthropicSseResponse single-consumer ownership
// ===========================================================================

describe("Phase 3: ARCH-3 encodeAnthropicSseResponse ownership", () => {
  function trackedEvents(
    events: TurnStreamEvent[],
    stats: { returned: number; pulls: number },
  ): AsyncIterable<TurnStreamEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
        let i = 0;
        return {
          async next() {
            stats.pulls += 1;
            const v = events[i++];
            return v === undefined
              ? { done: true, value: undefined }
              : { done: false, value: v };
          },
          async return() {
            stats.returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  function spyController() {
    const controller = new AbortController();
    let listeners = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    (controller.signal as any).addEventListener = (
      t: string,
      l: any,
      o?: any,
    ) => {
      if (t === "abort") listeners += 1;
      origAdd(t, l, o);
    };
    (controller.signal as any).removeEventListener = (
      t: string,
      l: any,
      o?: any,
    ) => {
      if (t === "abort") listeners = Math.max(0, listeners - 1);
      origRemove(t, l, o);
    };
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      listenerCount: () => listeners,
    };
  }

  test("pre-stream error resolves before the body exists; a live stream attaches one abort listener and releases it", async () => {
    // 1. The first event is peeked before the response is handed back, so an
    //    error arrives as its real HTTP status with the source closed once.
    const stats = { returned: 0, pulls: 0 };
    const errRes = await encodeAnthropicSseResponse(
      "m",
      trackedEvents(
        [
          {
            type: "error",
            status: 429,
            errorType: "rate_limit_error",
            message: "pool exhausted",
          },
        ],
        stats,
      ),
    );
    expect(errRes.status).toBe(429);
    expect(errRes.headers.get("content-type")).toContain("application/json");
    expect(stats.returned).toBe(1);
    expect(((await errRes.json()) as any).error.message).toBe("pool exhausted");

    // 2. A stream that starts with content is not closed by the peek: the body
    //    owns the iterator and is the only thing that releases it.
    const stats2 = { returned: 0, pulls: 0 };
    const spy = spyController();
    const okRes = await encodeAnthropicSseResponse(
      "m",
      trackedEvents(
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: USAGE_ZERO },
        ],
        stats2,
      ),
      spy.signal,
    );
    expect(okRes.status).toBe(200);
    expect(stats2.pulls).toBe(1);
    expect(stats2.returned).toBe(0);
    // Single PeekedTurnSource pre-claim listener only (no duplicate body listener)
    expect(spy.listenerCount()).toBe(1);
    expect(await okRes.text()).toContain("message_stop");
    expect(stats2.returned).toBe(1);
    expect(spy.listenerCount()).toBe(0);
  });

  test("awaited error maps to JSON error and simultaneous cancel+abort releases once", async () => {
    // 1. Pre-stream error event -> HTTP JSON 429 + closed once
    const errStats = { returned: 0, pulls: 0 };
    const errRes = await encodeAnthropicSseResponse(
      "m",
      trackedEvents(
        [
          {
            type: "error",
            status: 429,
            errorType: "rate_limit_error",
            message: "rate limited",
          },
        ],
        errStats,
      ),
    );
    expect(errRes.status).toBe(429);
    const errJson: any = await errRes.json();
    expect(errJson.error.message).toBe("rate limited");
    expect(errStats.returned).toBe(1);

    // 2. Pre-stream throw -> HTTP 502 + closed once
    const throwStats = { returned: 0 };
    const boom: AsyncIterable<TurnStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("worker crashed");
          },
          async return() {
            throwStats.returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const throwRes = await encodeAnthropicSseResponse("m", boom);
    expect(throwRes.status).toBe(502);
    expect(throwStats.returned).toBe(1);

    // 3. Cancel + abort simultaneously -> releases once, onBodyCancel once, 0 leaked listeners
    const raceStats = { returned: 0, pulls: 0 };
    const spy = spyController();
    let cancels = 0;
    const raceRes = await encodeAnthropicSseResponse(
      "m",
      trackedEvents(
        [
          { type: "text_delta", text: "x" },
          { type: "finish", stopReason: "end_turn", usage: USAGE_ZERO },
        ],
        raceStats,
      ),
      spy.signal,
      () => {
        cancels += 1;
      },
    );
    await Promise.all([raceRes.body!.cancel(), Promise.resolve(spy.abort())]);
    await new Promise((r) => setTimeout(r, 15));
    expect(raceStats.returned).toBe(1);
    expect(cancels).toBe(1);
    expect(spy.listenerCount()).toBe(0);
  });
});

// ===========================================================================
// 7. ARCH-4: combineSignals & createLoginSessionDisposer
// ===========================================================================

describe("Phase 3: ARCH-4 combineSignals & createLoginSessionDisposer", () => {
  test("combineSignals attributes abort vs timeout and detaches caller listener on dispose", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    (controller.signal as any).addEventListener = (t: string, l: any, o?: any) => {
      if (t === "abort") listeners += 1;
      origAdd(t, l, o);
    };
    (controller.signal as any).removeEventListener = (
      t: string,
      l: any,
      o?: any,
    ) => {
      if (t === "abort") listeners = Math.max(0, listeners - 1);
      origRemove(t, l, o);
    };

    // Caller abort attribution + dispose detaches listener
    const s1 = combineSignals(controller.signal, 5_000);
    expect(listeners).toBe(1);
    controller.abort();
    expect(s1.signal.aborted).toBe(true);
    expect(s1.callerAborted()).toBe(true);
    expect(s1.timedOut()).toBe(false);
    s1.dispose();
    expect(listeners).toBe(0);

    // Timeout attribution
    const longLived = new AbortController();
    const s2 = combineSignals(longLived.signal, 15);
    await new Promise((r) => setTimeout(r, 40));
    expect(s2.signal.aborted).toBe(true);
    expect(s2.timedOut()).toBe(true);
    expect(s2.callerAborted()).toBe(false);
    s2.dispose();
  });

  test("createLoginSessionDisposer idempotency, waitOutcome, and complete() suppressing cleanup", async () => {
    // 1. Timeout path runs onCleanup once
    const events1: Array<{ reason: string; msg: string }> = [];
    const d1 = createLoginSessionDisposer({
      timeoutMs: 15,
      timeoutMessage: "flow timed out",
      onCleanup: (reason, msg) => events1.push({ reason, msg }),
    });
    const out1 = await d1.waitOutcome(new Promise(() => {}));
    expect(out1).toEqual({ kind: "timeout", message: "flow timed out" });
    expect(d1.abandonReason()).toBe("flow timed out");
    d1.dispose("extra");
    d1.dispose("extra2");
    expect(events1).toEqual([{ reason: "timeout", msg: "flow timed out" }]);

    // 2. Caller abort path
    const ac = new AbortController();
    const events2: Array<{ reason: string; msg: string }> = [];
    const d2 = createLoginSessionDisposer({
      callerSignal: ac.signal,
      timeoutMs: 5_000,
      abortMessage: "user cancelled",
      onCleanup: (reason, msg) => events2.push({ reason, msg }),
    });
    setTimeout(() => ac.abort(), 10);
    const out2 = await d2.waitOutcome(new Promise(() => {}));
    expect(out2).toEqual({ kind: "aborted", message: "user cancelled" });
    expect(events2).toEqual([{ reason: "aborted", msg: "user cancelled" }]);

    // 3. complete() marks success and prevents subsequent dispose() rollback
    const ac3 = new AbortController();
    let cleanupCount = 0;
    const d3 = createLoginSessionDisposer({
      callerSignal: ac3.signal,
      timeoutMs: 5_000,
      onCleanup: () => {
        cleanupCount += 1;
      },
    });
    const out3 = await d3.waitOutcome(Promise.resolve("ok-code"));
    expect(out3).toEqual({ kind: "resolved", value: "ok-code" });
    d3.complete();
    ac3.abort();
    d3.dispose("after complete");
    expect(cleanupCount).toBe(0);
    expect(d3.abandonReason()).toBeNull();
  });
});

// ===========================================================================
// 8. CARRY-2: scripts/check-release.mjs release gate
// ===========================================================================

describe("Phase 3: CARRY-2 scripts/check-release.mjs", () => {
  test("passes on matching package.json version tag and fails on mismatched tag", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    const expectedTag = `v${pkg.version}`;
    const isolatedHome = makeTempDir("agy-release-home-");

    const ok = spawnSync(
      "bun",
      ["scripts/check-release.mjs", "--tag", expectedTag],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, "cfg"),
          XDG_CACHE_HOME: path.join(isolatedHome, "cache"),
          ANTIGRAVITY_MAGPIE_DATA_DIR: path.join(isolatedHome, "data"),
          AGY_ACP_DATA_DIR: path.join(isolatedHome, "data"),
        },
        timeout: 30_000,
      },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("✓");

    const bad = spawnSync(
      "bun",
      ["scripts/check-release.mjs", "--tag", "v99.0.0"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, "cfg"),
          XDG_CACHE_HOME: path.join(isolatedHome, "cache"),
          ANTIGRAVITY_MAGPIE_DATA_DIR: path.join(isolatedHome, "data"),
          AGY_ACP_DATA_DIR: path.join(isolatedHome, "data"),
        },
        timeout: 30_000,
      },
    );
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain("✗");
  });

  test("hooks.auth.maxConcurrency defaults to 18 and respects pkgOptions.maxPerAccountWorkers", async () => {
    expect(pluginEntry.id).toBe("agy-acp");

    const defaultHooks = await pluginEntry.server();
    expect(defaultHooks.auth.provider).toBe("agy-acp");
    expect(defaultHooks.auth.maxConcurrency).toBe(18);

    const customHooks = await pluginEntry.server(undefined, {
      maxPerAccountWorkers: 7,
    });
    expect(customHooks.auth.maxConcurrency).toBe(7);

    for (const invalid of [0, -4, 3.5, "not-an-int", null]) {
      const fallbackHooks = await pluginEntry.server(undefined, {
        maxPerAccountWorkers: invalid,
      });
      expect(fallbackHooks.auth.maxConcurrency).toBe(18);
    }
  });
});
