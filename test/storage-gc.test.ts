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
import { withEnv } from "./fixtures/helpers";

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

/** One `conversation_summaries` row: the conversation id and its last-modified stamp. */
type SummaryRow = readonly [id: string, lastModifiedMs: number];
/** One `conversation_parents` row: the conversation id and its parent id. */
type ParentLink = readonly [id: string, parentId: string];

/** Seeds `conversation_summaries.db` the way `agy` writes it (table, FTS index, parent links). */
function seedSummaryDb(
  cliDir: string,
  rows: readonly SummaryRow[],
  parents: readonly ParentLink[] = [],
): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    for (const [id, lastModifiedMs] of rows) {
      const title = `title-${id}`;
      db.run(
        "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time) VALUES (?, ?, ?)",
        id,
        title,
        new Date(lastModifiedMs).toISOString(),
      );
      db.run("INSERT INTO conversations_fts (conversation_id, title) VALUES (?, ?)", id, title);
    }
    for (const [id, parentId] of parents) {
      db.run(
        "INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)",
        id,
        parentId,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/** Reads back what the GC left in `conversation_summaries.db` (read-only, no sidecars). */
function readSummaryTables(dbPath: string, ftsTerms: readonly string[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, 1);
  try {
    const ids = (sql: string): string[] =>
      db.prepare(sql).all().map((row: any) => row.conversation_id);
    const ftsMatches: Record<string, number> = {};
    for (const term of ftsTerms) {
      ftsMatches[term] = Number(
        (
          db
            .prepare("SELECT count(*) AS cnt FROM conversations_fts WHERE conversations_fts MATCH ?")
            .get(term) as any
        )?.cnt ?? -1,
      );
    }
    return {
      summaryIds: ids("SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id"),
      ftsIds: ids("SELECT conversation_id FROM conversations_fts ORDER BY conversation_id"),
      parentLinks: db
        .prepare("SELECT conversation_id, parent_id FROM conversation_parents ORDER BY conversation_id")
        .all() as Array<{ conversation_id: string; parent_id: string }>,
      ftsMatches,
    };
  } finally {
    db.close();
  }
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
    const conversations = path.join(cliDir, "conversations");

    // Live .db session NOT in protectedSessionIds must still shield its old artifacts.
    writeFile(path.join(conversations, "active-db-sess.db"), "db", freshMs);

    writeFile(path.join(annotations, "old-sess.pbtxt"), "old", oldMs);
    writeFile(path.join(annotations, "keep-sess.pbtxt"), "keep", oldMs);
    writeFile(path.join(annotations, "active-db-sess.pbtxt"), "active", oldMs);
    writeFile(path.join(annotations, "fresh-sess.pbtxt"), "fresh", freshMs);

    writeFile(path.join(implicit, "old-sess.pb"), "old", oldMs);
    writeFile(path.join(implicit, "keep-sess.pb"), "keep", oldMs);
    writeFile(path.join(implicit, "active-db-sess.pb"), "active", oldMs);
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

    expect(fs.existsSync(path.join(annotations, "active-db-sess.pbtxt"))).toBe(true);
    expect(fs.existsSync(path.join(implicit, "active-db-sess.pb"))).toBe(true);

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

    // A brand-new cli.log (< 60s old) is left untouched even when above cap.
    writeFile(cliLogPath, `${head}${tail}`, nowMs - 10_000);
    const untouchedFresh = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
    );
    expect(untouchedFresh).toBe(0);
    expect(fs.readFileSync(cliLogPath, "utf8").length).toBe(5100);

    // Once older than 60s, it is tail-truncated to the newest maxLogDirBytes.
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

    // A stale cli.log is truncated in place to 0 bytes (preserving inode & O_APPEND writers).
    writeFile(cliLogPath, "stale", nowMs - 49 * 60 * 60 * 1000);
    const staleIno = fs.statSync(cliLogPath).ino;
    const appendFd = fs.openSync(cliLogPath, "a");
    try {
      const removedAgain = sweepIn(dataRoot, () =>
        sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
      );
      expect(removedAgain).toBe(1);
      expect(fs.existsSync(cliLogPath)).toBe(true);
      expect(fs.readFileSync(cliLogPath, "utf8")).toBe("");
      expect(fs.statSync(cliLogPath).ino).toBe(staleIno);

      // Sweeping an already-0-byte stale cli.log is a no-op and returns 0.
      ageFile(cliLogPath, nowMs - 49 * 60 * 60 * 1000);
      const removedEmpty = sweepIn(dataRoot, () =>
        sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
      );
      expect(removedEmpty).toBe(0);

      // Open O_APPEND writer still writes to the same file/inode after stale emptying.
      fs.writeSync(appendFd, Buffer.from("STILL-OPEN\n"));
    } finally {
      fs.closeSync(appendFd);
    }
    expect(fs.statSync(cliLogPath).ino).toBe(staleIno);
    expect(fs.readFileSync(cliLogPath, "utf8")).toBe("STILL-OPEN\n");
  });

  test("in-place truncation of cli.log preserves an open O_APPEND writer inode and subsequent writes", () => {
    const { dataRoot, cliDir } = makeFixture("clilog-inode");
    const nowMs = Date.now();
    const cliLogPath = path.join(cliDir, "cli.log");

    writeFile(cliLogPath, `${"A".repeat(5000)}${"B".repeat(100)}`, nowMs - 5 * 60_000);
    const beforeIno = fs.statSync(cliLogPath).ino;
    const appendFd = fs.openSync(cliLogPath, "a");
    try {
      const removed = sweepIn(dataRoot, () =>
        sweepStaleAccountStorage({ now: nowMs, maxLogDirBytes: 4096 }),
      );
      expect(removed).toBe(1);

      fs.writeSync(appendFd, Buffer.from("\nLIVE-APPEND-AFTER-GC\n"));
    } finally {
      fs.closeSync(appendFd);
    }

    expect(fs.statSync(cliLogPath).ino).toBe(beforeIno);
    const after = fs.readFileSync(cliLogPath, "utf8");
    expect(after.endsWith("LIVE-APPEND-AFTER-GC\n")).toBe(true);
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

    const dbPath = seedSummaryDb(
      cliDir,
      [
        // kept = transcript exists; orphan = pruned transcript + old timestamp;
        // recent = pruned transcript but inside the 5 minute grace window;
        // child = a kept conversation whose parent was pruned.
        ["kept-sess", nowMs - 60_000],
        ["orphan-sess", oldMs],
        ["recent-sess", nowMs - 30_000],
        ["child-sess", oldMs],
      ],
      [
        ["child-sess", "orphan-sess"],
        ["orphan-sess", "kept-sess"],
        ["kept-sess", "fresh-sess"],
      ],
    );

    const removed = sweepIn(dataRoot, () =>
      sweepStaleAccountStorage({
        now: nowMs,
        protectedSessionIds: new Set(["kept-sess"]),
      }),
    );

    // One orphan id removed from the summary table.
    expect(removed).toBe(1);

    const { summaryIds, ftsIds, parentLinks, ftsMatches } = readSummaryTables(dbPath, [
      "orphan",
      "kept",
      "child",
      "recent",
    ]);
    expect(summaryIds).toEqual(["child-sess", "kept-sess", "recent-sess"]);
    expect(ftsIds).toEqual(["child-sess", "kept-sess", "recent-sess"]);
    expect(ftsMatches.orphan).toBe(0);
    expect(ftsMatches.kept).toBeGreaterThan(0);
    expect(ftsMatches.child).toBeGreaterThan(0);
    expect(ftsMatches.recent).toBeGreaterThan(0);
    // Links referencing orphan-sess are dropped; the live kept->fresh link survives.
    expect(parentLinks).toEqual([{ conversation_id: "kept-sess", parent_id: "fresh-sess" }]);

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

  test("preserves summary, FTS, and parent rows when an expired transcript .db survives failed deletion", () => {
    const { dataRoot, cliDir } = makeFixture("summary-survives-unlink-fail");
    const nowMs = Date.now();
    const oldMs = nowMs - 49 * 60 * 60 * 1000;
    const convDir = path.join(cliDir, "conversations");
    const stuckDbPath = path.join(convDir, "stuck-sess.db");

    writeFile(stuckDbPath, "db", oldMs);
    writeFile(path.join(convDir, "parent-live.db"), "db", nowMs - 60_000);

    const dbPath = seedSummaryDb(
      cliDir,
      [
        ["stuck-sess", oldMs],
        ["parent-live", nowMs - 60_000],
        ["gone-orphan", oldMs],
      ],
      [["stuck-sess", "parent-live"]],
    );

    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) {
      return;
    }

    fs.chmodSync(convDir, 0o500);
    try {
      sweepIn(dataRoot, () => sweepStaleAccountStorage({ now: nowMs }));
    } finally {
      fs.chmodSync(convDir, 0o700);
    }

    expect(fs.existsSync(stuckDbPath)).toBe(true);

    // The undeletable transcript keeps its summary, FTS entry, and parent link.
    const { summaryIds, ftsIds, parentLinks, ftsMatches } = readSummaryTables(dbPath, ["stuck"]);
    expect(summaryIds).toEqual(["parent-live", "stuck-sess"]);
    expect(ftsIds).toEqual(["parent-live", "stuck-sess"]);
    expect(ftsMatches.stuck).toBeGreaterThan(0);
    expect(parentLinks).toEqual([{ conversation_id: "stuck-sess", parent_id: "parent-live" }]);
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
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "catalog-cache-"));
    try {
      await withEnv(
        { AGY_ACP_DATA_DIR: sandbox, AGY_PATH: writeMockModelsBinary() },
        async () => {
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
        },
      );
    } finally {
      // A failing assertion inside a fake-clock window must not leak the clock.
      setSystemTime();
    }
  });

  test("caps CatalogService cache at 128 entries oldest-first while preserving <24h lastGood fallback", async () => {
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "catalog-cap-"));
    try {
      await withEnv(
        { AGY_ACP_DATA_DIR: sandbox, AGY_PATH: writeMockModelsBinary() },
        async () => {
          const service = new CatalogService();
          const baseNow = Date.now();

          const accounts: AccountDescriptor[] = Array.from({ length: 130 }, (_, i) => ({
            slotKey: `agy-acp#cap-${i}`,
            accountRef: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            mode: "host",
            label: `cap-${i}`,
            isolatedHomeDir: null,
          }));

          for (let i = 0; i < accounts.length; i++) {
            setSystemTime(new Date(baseNow + i * 10));
            const res = await service.getCatalogWithMeta(accounts[i]!, {
              forceRefresh: true,
            });
            expect(res.fellBack).toBe(false);
            expect(res.catalog.isFallback).toBe(false);
            if (i === 128) {
              // Immediately after the 129th distinct insert, the 128-entry cap holds.
              expect(service.getCacheSize()).toBe(128);
            }
          }
          expect(service.getCacheSize()).toBe(128);

          // Switch to failing probe 10 minutes later (<24h stale horizon).
          // Account 0 was evicted by the 128-entry cap, so it falls back to static fallback;
          // the lookup also trims cache size to <= 128. Account 129 stays retained as lastGood.
          setSystemTime(new Date(baseNow + 10 * 60 * 1000));
          process.env.AGY_PATH = writeFailingModelsBinary();

          const evictedRes = await service.getCatalogWithMeta(accounts[0]!, {
            forceRefresh: true,
          });
          expect(service.getCacheSize()).toBe(128);
          expect(evictedRes.fellBack).toBe(true);
          expect(evictedRes.catalog.isFallback).toBe(true);

          const retainedRes = await service.getCatalogWithMeta(accounts[129]!, {
            forceRefresh: true,
          });
          expect(retainedRes.fellBack).toBe(true);
          expect(retainedRes.catalog.isFallback).toBe(false);
          expect(service.getCacheSize()).toBe(128);
        },
      );
    } finally {
      setSystemTime();
    }
  }, 30_000);

  test("caps CatalogService cache at <= 128 immediately after a 150-account concurrent Promise.all burst", async () => {
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "catalog-burst-"));
    const delayedBin = path.join(TEST_DIR, "mock-agy-models-delayed.sh");
    fs.writeFileSync(
      delayedBin,
      `#!/bin/sh\nsleep 0.03\nif [ "$1" = "models" ]; then\n  printf '%s' '${MODELS_OUTPUT}'\n  exit 0\nfi\nexit 1\n`,
      { mode: 0o755 },
    );
    await withEnv({ AGY_ACP_DATA_DIR: sandbox, AGY_PATH: delayedBin }, async () => {
      const service = new CatalogService();
      const accounts: AccountDescriptor[] = Array.from({ length: 150 }, (_, i) => ({
        slotKey: `agy-acp#burst-${i}`,
        accountRef: `00000000-0000-4100-8000-${String(i).padStart(12, "0")}`,
        mode: "host",
        label: `burst-${i}`,
        isolatedHomeDir: null,
      }));

      const results = await Promise.all(
        accounts.map((acct) =>
          service.getCatalogWithMeta(acct, { forceRefresh: true }),
        ),
      );
      for (const res of results) {
        expect(res.fellBack).toBe(false);
        expect(res.catalog.isFallback).toBe(false);
      }
      expect(service.getCacheSize()).toBe(128);
    });
  }, 30_000);
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
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "quota-cache-"));
    try {
      await withEnv(
        { AGY_ACP_DATA_DIR: sandbox, AGY_PATH: writeMockUsageBinary() },
        async () => {
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
        },
      );
    } finally {
      setSystemTime();
    }
  });

  test("caps live queryAccountUsage usageCache at 128 entries via lazy eviction", async () => {
    const sandbox = fs.mkdtempSync(path.join(TEST_DIR, "quota-cap-"));
    const failBin = path.join(TEST_DIR, "mock-agy-usage-fail.sh");
    fs.writeFileSync(failBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      await withEnv({ AGY_ACP_DATA_DIR: sandbox, AGY_PATH: failBin }, async () => {
        const baseNow = Date.now();
        // First flush any entries left behind by earlier tests (even future-skewed ones).
        setSystemTime(new Date(baseNow + 80_000));
        await queryAccountUsage(
          usageAccount(
            "44444444-4444-4444-8444-999999999998",
            "agy-acp#quota-cap-preflush",
          ),
          [],
          { quotaRouting: false },
        );
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(0);

        // Populate 130 distinct accounts using timestamps inside the 30s TTL window
        // ending in the past/present so nothing is left pinned in the future.
        process.env.AGY_PATH = writeMockUsageBinary();
        for (let i = 0; i < 130; i++) {
          setSystemTime(new Date(baseNow - 20_000 + i * 50));
          const acct = usageAccount(
            `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
            `agy-acp#quota-cap-${i}`,
          );
          const res = await queryAccountUsage(acct, [], { quotaRouting: false });
          expect(res.signIn).toBe("kept");
          expect(res.windows.length).toBeGreaterThan(0);
          if (i === 128) {
            // Immediately after the 129th insert, usageCacheSize is capped at 128.
            expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(128);
          }
        }
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(128);

        // Querying account 129 again hits cache (no new insertion) after lazy prune trims to 128.
        setSystemTime(new Date(baseNow - 20_000 + 130 * 50));
        await queryAccountUsage(
          usageAccount(
            "44444444-4444-4444-8444-000000000129",
            "agy-acp#quota-cap-129",
          ),
          [],
          { quotaRouting: false },
        );
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(128);

        // Verify oldest entry (account 0) was evicted: switch to failing probe and query it.
        process.env.AGY_PATH = failBin;
        const evictedRes = await queryAccountUsage(
          usageAccount(
            "44444444-4444-4444-8444-000000000000",
            "agy-acp#quota-cap-0",
          ),
          [],
          { quotaRouting: false },
        );
        expect(evictedRes.error).toBeDefined();
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(128);

        // Flush expired entries >30s later so the process-wide cache starts clean.
        setSystemTime(new Date(baseNow + 40_000));
        await queryAccountUsage(
          usageAccount(
            "44444444-4444-4444-8444-999999999999",
            "agy-acp#quota-cap-flush",
          ),
          [],
          { quotaRouting: false },
        );
        expect(__getQuotaCacheStatsForTest().usageCacheSize).toBe(0);
      });
    } finally {
      setSystemTime();
    }
  }, 30_000);
});
