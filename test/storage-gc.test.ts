import { afterAll, describe, expect, test, setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sweepStaleAccountStorage } from "../src/accounts/env";
import { CatalogService } from "../src/usage/catalog";
import {
  __getQuotaCacheStatsForTest,
  evictOldestEntries,
  queryAccountUsage,
} from "../src/usage/quota";
import type { AccountDescriptor } from "../src/types";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-storage-gc-test-"));
const VALID_UUID = "9f4c2d7e-1a3b-4c5d-8e9f-0a1b2c3d4e5f";

afterAll(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

interface Fixture {
  dataRoot: string;
  cliDir: string;
}

/** Builds `$DATA_ROOT/accounts/<uuid>/.gemini/antigravity-cli` for one GC run. */
function makeFixture(name: string): Fixture {
  const dataRoot = fs.mkdtempSync(path.join(TEST_DIR, `${name}-`));
  const cliDir = path.join(
    dataRoot,
    "accounts",
    VALID_UUID,
    ".gemini",
    "antigravity-cli",
  );
  fs.mkdirSync(cliDir, { recursive: true });
  return { dataRoot, cliDir };
}

/** Runs the sweep against `dataRoot`, restoring the data-dir env afterwards. */
function sweepIn<T>(dataRoot: string, run: () => T): T {
  const prev = process.env.AGY_ACP_DATA_DIR;
  process.env.AGY_ACP_DATA_DIR = dataRoot;
  try {
    return run();
  } finally {
    if (prev !== undefined) process.env.AGY_ACP_DATA_DIR = prev;
    else delete process.env.AGY_ACP_DATA_DIR;
  }
}

function ageFile(file: string, mtimeMs: number): void {
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
}

function writeFile(file: string, content: string, mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeMs !== undefined) ageFile(file, mtimeMs);
}

describe("src/accounts/env.ts sweepStaleAccountStorage phase 2", () => {
  test("prunes stale annotations, implicit blobs, and crash logs while keeping protected and fresh ones", () => {
    const { dataRoot, cliDir } = makeFixture("artifacts");
    const nowMs = Date.now();
    const oldMs = nowMs - 49 * 60 * 60 * 1000;
    const freshMs = nowMs - 30 * 60 * 1000;

    const annotations = path.join(cliDir, "annotations");
    const implicit = path.join(cliDir, "implicit");
    const crashes = path.join(cliDir, "crashes");

    writeFile(path.join(annotations, "old-sess.pbtxt"), "old", oldMs);
    writeFile(path.join(annotations, "keep-sess.pbtxt"), "keep", oldMs);
    writeFile(path.join(annotations, "fresh-sess.pbtxt"), "fresh", freshMs);

    writeFile(path.join(implicit, "old-sess.pb"), "old", oldMs);
    writeFile(path.join(implicit, "keep-sess.pb"), "keep", oldMs);
    writeFile(path.join(implicit, "fresh-sess.pb"), "fresh", freshMs);

    writeFile(path.join(crashes, "crash-old.log"), "old", oldMs);
    writeFile(path.join(crashes, "crash-keep-sess.log"), "keep", oldMs);
    writeFile(path.join(crashes, "crash-fresh.log"), "fresh", freshMs);

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({
        now: nowMs,
        protectedSessionIds: new Set(["keep-sess"]),
      }),
    );

    // 3 stale artifacts: annotation + implicit blob + crash log.
    expect(removed).toBe(3);

    expect(fs.existsSync(path.join(annotations, "old-sess.pbtxt"))).toBe(false);
    expect(fs.existsSync(path.join(implicit, "old-sess.pb"))).toBe(false);
    expect(fs.existsSync(path.join(crashes, "crash-old.log"))).toBe(false);

    expect(fs.existsSync(path.join(annotations, "keep-sess.pbtxt"))).toBe(true);
    expect(fs.existsSync(path.join(implicit, "keep-sess.pb"))).toBe(true);
    expect(fs.existsSync(path.join(crashes, "crash-keep-sess.log"))).toBe(true);

    expect(fs.existsSync(path.join(annotations, "fresh-sess.pbtxt"))).toBe(true);
    expect(fs.existsSync(path.join(implicit, "fresh-sess.pb"))).toBe(true);
    expect(fs.existsSync(path.join(crashes, "crash-fresh.log"))).toBe(true);
  });

  test("caps the retained log directory and deletes the oldest logs first", () => {
    const { dataRoot, cliDir } = makeFixture("logcap");
    const nowMs = Date.now();
    const logDir = path.join(cliDir, "log");

    // 5 logs x 10 bytes = 50 bytes; cap at 25 bytes keeps the 2 newest.
    for (let i = 0; i < 5; i++) {
      writeFile(
        path.join(logDir, `cli-${i}.log`),
        "0123456789",
        nowMs - (5 - i) * 60_000,
      );
    }

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 25 }),
    );

    expect(removed).toBe(3);
    expect(fs.existsSync(path.join(logDir, "cli-0.log"))).toBe(false);
    expect(fs.existsSync(path.join(logDir, "cli-1.log"))).toBe(false);
    expect(fs.existsSync(path.join(logDir, "cli-2.log"))).toBe(false);
    expect(fs.existsSync(path.join(logDir, "cli-3.log"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "cli-4.log"))).toBe(true);
  });

  test("age-prunes and tail-truncates the root cli.log, keeping the newest bytes", () => {
    const { dataRoot, cliDir } = makeFixture("clilog");
    const nowMs = Date.now();
    const cliLogPath = path.join(cliDir, "cli.log");

    const head = "A".repeat(5000);
    const tail = "B".repeat(100);
    writeFile(cliLogPath, `${head}${tail}`, nowMs - 5 * 60_000);

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
    );

    expect(removed).toBe(1);
    expect(fs.existsSync(cliLogPath)).toBe(true);
    const truncated = fs.readFileSync(cliLogPath, "utf8");
    expect(truncated.length).toBe(4096);
    expect(truncated.endsWith(tail)).toBe(true);
    expect(truncated.startsWith("A")).toBe(true);

    // A stale cli.log is deleted outright rather than truncated.
    writeFile(cliLogPath, "stale", nowMs - 49 * 60 * 60 * 1000);
    const removedAgain = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
    );
    expect(removedAgain).toBe(1);
    expect(fs.existsSync(cliLogPath)).toBe(false);
  });

  test("reclaims orphaned conversation_summaries rows, FTS entries, and parent links", async () => {
    const { dataRoot, cliDir } = makeFixture("summarydb");
    const nowMs = Date.now();
    const oldMs = nowMs - 49 * 60 * 60 * 1000;

    // Live transcripts that MUST survive (one protected, one merely fresh).
    writeFile(
      path.join(cliDir, "conversations", "kept-sess.db"),
      "db",
      nowMs - 60_000,
    );
    writeFile(
      path.join(cliDir, "conversations", "fresh-sess.db"),
      "db",
      nowMs - 60_000,
    );
    // A live transcript that hangs off an orphaned parent conversation.
    writeFile(
      path.join(cliDir, "conversations", "child-sess.db"),
      "db",
      nowMs - 60_000,
    );

    const { Database } = require("bun:sqlite");
    const dbPath = path.join(cliDir, "conversation_summaries.db");
    const db = new Database(dbPath);
    try {
      db.run(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', last_modified_time datetime NOT NULL)",
      );
      db.run(
        "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) WITHOUT ROWID",
      );
      db.run(
        "CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, title, tokenize = 'unicode61')",
      );
      const iso = (ms: number) => new Date(ms).toISOString();
      // kept = transcript exists; orphan = pruned transcript + old timestamp;
      // recent = pruned transcript but inside the 5 minute grace window;
      // child = a kept conversation whose parent was pruned.
      const rows: Array<[string, string]> = [
        ["kept-sess", iso(nowMs - 60_000)],
        ["orphan-sess", iso(oldMs)],
        ["recent-sess", iso(nowMs - 30_000)],
        ["child-sess", iso(oldMs)],
      ];
      for (const [id, ts] of rows) {
        db.run(
          "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time) VALUES (?, ?, ?)",
          id,
          `title-${id}`,
          ts,
        );
        db.run(
          "INSERT INTO conversations_fts (conversation_id, title) VALUES (?, ?)",
          id,
          `title-${id}`,
        );
      }
      db.run(
        "INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)",
        "child-sess",
        "orphan-sess",
      );
    } finally {
      db.close();
    }

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({
        now: nowMs,
        protectedSessionIds: new Set(["kept-sess"]),
      }),
    );

    // One orphan id removed from the summary table.
    expect(removed).toBe(1);

    const verify = new Database(dbPath, 1); // read-only
    try {
      const summaryIds = verify
        .prepare("SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id")
        .all()
        .map((row: any) => row.conversation_id);
      expect(summaryIds).toEqual(["child-sess", "kept-sess", "recent-sess"]);

      const ftsIds = verify
        .prepare("SELECT conversation_id FROM conversations_fts ORDER BY conversation_id")
        .all()
        .map((row: any) => row.conversation_id);
      expect(ftsIds).toEqual(["child-sess", "kept-sess", "recent-sess"]);

      const parents = verify
        .prepare("SELECT conversation_id, parent_id FROM conversation_parents")
        .all();
      // The link pointing at the pruned parent is dropped with it.
      expect(parents.length).toBe(0);
    } finally {
      verify.close();
    }

    // The transcripts themselves were never touched by the summary cleanup.
    expect(fs.existsSync(path.join(cliDir, "conversations", "kept-sess.db"))).toBe(true);
    expect(fs.existsSync(path.join(cliDir, "conversations", "fresh-sess.db"))).toBe(true);
    expect(fs.existsSync(path.join(cliDir, "conversations", "child-sess.db"))).toBe(true);
  });

  test("never creates conversation_summaries.db when the account has none", () => {
    const { dataRoot, cliDir } = makeFixture("nosummary");
    const nowMs = Date.now();
    writeFile(
      path.join(cliDir, "conversations", "kept-sess.db"),
      "db",
      nowMs - 60_000,
    );

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({ now: nowMs }),
    );

    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(cliDir, "conversation_summaries.db"))).toBe(false);
  });
});

describe("src/usage/catalog.ts cache retention", () => {
  const MODELS_OUTPUT =
    "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n" +
    "gemini-4-carbon-high\tGemini 4 Carbon (High)\n" +
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n";

  function writeMockModelsBinary(): string {
    const bin = path.join(TEST_DIR, "mock-agy-models.sh");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "models" ]; then\n  printf '%s' '${MODELS_OUTPUT}'\n  exit 0\nfi\nexit 1\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  function writeFailingModelsBinary(): string {
    const bin = path.join(TEST_DIR, "mock-agy-models-fail.sh");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    return bin;
  }

  const account: AccountDescriptor = {
    slotKey: "agy-acp#cache",
    accountRef: "11111111-1111-4111-8111-111111111111",
    mode: "host",
    label: "cache test",
    isolatedHomeDir: null,
  };

  test("keeps a real catalog cached across a failing probe well past the 5 minute TTL", async () => {
    const prevAgy = process.env.AGY_PATH;
    const prevDataDir = process.env.AGY_ACP_DATA_DIR;
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "catalog-cache-"));
    process.env.AGY_ACP_DATA_DIR = sandbox;
    try {
      process.env.AGY_PATH = writeMockModelsBinary();
      const service = new CatalogService();
      const live = await service.getCatalogWithMeta(account, { forceRefresh: true });
      expect(live.fellBack).toBe(false);
      expect(live.catalog.isFallback).toBe(false);
      expect(service.getCacheSize()).toBe(1);

      // 30 minutes later (6x the 5 minute TTL) the cached list must survive.
      const realNow = Date.now();
      setSystemTime(new Date(realNow + 30 * 60 * 1000));
      try {
        process.env.AGY_PATH = writeFailingModelsBinary();
        const degraded = await service.getCatalogWithMeta(account, {
          forceRefresh: true,
        });
        expect(degraded.fellBack).toBe(true);
        // Never advertise a narrower list just because the probe failed.
        expect(degraded.catalog.isFallback).toBe(false);
        expect(Object.keys(degraded.catalog.models ?? {}).length).toBe(
          Object.keys(live.catalog.models ?? {}).length,
        );
        expect(service.getCacheSize()).toBe(1);
      } finally {
        setSystemTime();
      }

      // Beyond the 24 hour stale horizon the entry is dropped again.
      const realNow2 = Date.now();
      setSystemTime(new Date(realNow2 + 25 * 60 * 60 * 1000));
      try {
        await service.getCatalogWithMeta(account, { forceRefresh: true });
        expect(service.getCacheSize()).toBe(0);
      } finally {
        setSystemTime();
      }
    } finally {
      setSystemTime();
      if (prevAgy !== undefined) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
      if (prevDataDir !== undefined) process.env.AGY_ACP_DATA_DIR = prevDataDir;
      else delete process.env.AGY_ACP_DATA_DIR;
    }
  });
});

describe("src/usage/quota.ts lazy cache eviction", () => {
  const USAGE_JSON = {
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: 0.5,
                reset_time: "2026-11-14T07:57:52Z",
              },
              {
                id: "gemini-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: 0.7,
                reset_time: "2026-11-13T04:25:05Z",
              },
            ],
          },
        ],
      },
    },
  };

  function writeMockUsageBinary(): string {
    const bin = path.join(TEST_DIR, "mock-agy-usage.sh");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s' '${JSON.stringify(USAGE_JSON)}'\nexit 0\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  function usageAccount(ref: string, slotKey: string): AccountDescriptor {
    return {
      slotKey,
      accountRef: ref,
      mode: "host",
      label: slotKey,
      isolatedHomeDir: null,
    };
  }

  test("caps a cache map at 128 entries, oldest first, and skips in-flight work", () => {
    const cache = new Map<string, { timestamp: number; inFlight?: Promise<unknown> }>();
    for (let i = 0; i < 130; i++) {
      cache.set(`k${i}`, { timestamp: 1_000 + i });
    }
    // An in-flight entry is the oldest of all and must never be evicted.
    cache.set("inflight", { timestamp: 0, inFlight: Promise.resolve(undefined) });

    evictOldestEntries(
      cache,
      (entry) => !entry.inFlight,
      (entry) => entry.timestamp,
    );

    expect(cache.size).toBe(128);
    expect(cache.has("inflight")).toBe(true);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("k2")).toBe(false);
    expect(cache.has("k129")).toBe(true);
  });

  test("drops expired usage entries on the next call instead of growing forever", async () => {
    const prevAgy = process.env.AGY_PATH;
    const prevDataDir = process.env.AGY_ACP_DATA_DIR;
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "quota-cache-"));
    process.env.AGY_ACP_DATA_DIR = sandbox;
    process.env.AGY_PATH = writeMockUsageBinary();
    try {
      const first = usageAccount(
        "22222222-2222-4222-8222-222222222222",
        "agy-acp#quota-a",
      );
      const second = usageAccount(
        "33333333-3333-4333-8333-333333333333",
        "agy-acp#quota-b",
      );

      await queryAccountUsage(first, [], { quotaRouting: false });
      expect(__getQuotaCacheStatsForTest().usageCacheSize).toBeGreaterThanOrEqual(1);

      // 40s later every 30s usage TTL has elapsed: all cached entries must go.
      // (Other test files share this process-wide cache, so the assertion is
      // absolute rather than relative to whatever they left behind.)
      const realNow = Date.now();
      setSystemTime(new Date(realNow + 40_000));
      try {
        await queryAccountUsage(second, [], { quotaRouting: false });
        // Only the account queried after the time jump survives.
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(1);
      } finally {
        setSystemTime();
      }
    } finally {
      setSystemTime();
      if (prevAgy !== undefined) process.env.AGY_PATH = prevAgy;
      else delete process.env.AGY_PATH;
      if (prevDataDir !== undefined) process.env.AGY_ACP_DATA_DIR = prevDataDir;
      else delete process.env.AGY_ACP_DATA_DIR;
    }
  });
});
