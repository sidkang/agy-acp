// Shelf store: the in-memory warm shelf and the zero-plaintext on-disk resume
// index, behind one deep module (ARCH-1), with file-locked incremental writes
// (MED-10) and a secondary content-hash lookup for callers that send no session
// header.
//
// Two shelves, one contract `park() / invalidate() / resolveResume()`:
//
//   * memory  — `ParkedSession` values that keep the whole ledger in RAM, bounded
//               by entry size, entry count and total bytes.
//   * persisted — digest-only entries in `<plugin data root>/parked-sessions.json`
//               (`0o600`, atomic rename) that survive a plugin-host restart. They
//               never carry message text, tool arguments, tool outputs, system
//               prompt text, or the system history seed.
//
// Why the file lock matters (MED-10): two hosts can share one data root (Magpie
// plus a CLI/test run). A whole-map overwrite from a stale in-memory snapshot
// loses the other process's writes and can resurrect a checkpoint the other
// process just invalidated. Every mutation here is therefore a read-modify-write
// *inside* a short exclusive lock, reloading the on-disk snapshot first.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AccountDescriptor,
  type NormalizedAnthropicRequest,
  type NormalizedMessage,
} from "../types";
import { stripVolatileSystem } from "../protocol/cloak";
import { getPluginDataRoot, isPidAlive } from "../accounts/env";
import { resolveConversationDbPath } from "../usage/step-usage";
import {
  type PersistedParkedSession,
  type PrefixMatchResult,
  type ToolDefLike,
  digestMessagesForPersistence,
  digestToolsForPersistence,
  heardRuns,
  isToolSetCompatible,
  matchLedgerPrefix,
  matchPersistedPrefix,
  normalizePersistedEntry,
  normalizeWorkDir,
  sha256Hex,
  subagentIdFromSessionKey,
  systemPromptsMatch,
  toolsMatchPersistedDigests,
  utf8Bytes,
} from "./ledger";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How long a parked session may be woken. */
export const PARKED_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Memory shelf entry count. */
export const MAX_PARKED_SESSIONS = 32;
/** One memory entry may not exceed this (a larger ledger cannot be retained). */
export const MAX_SINGLE_PARKED_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Everything the memory shelf may hold. */
export const MAX_TOTAL_PARKED_BYTES = 16 * 1024 * 1024; // 16 MiB
/** On-disk index entry count. */
export const MAX_PERSISTED_PARKED_SESSIONS = 32;
/** Shelf file name inside the plugin data root. */
export const SHELF_FILE_NAME = "parked-sessions.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything the shelf needs to know about a worker to decide whether — and how
 * — its native session can be woken later.
 */
export interface WorkerParkSnapshot {
  /** Caller-visible session id (`worker.sessionId`). */
  sessionId: string;
  /** Native `agy` conversation id (`worker.nativeSessionId`). */
  nativeSessionId: string;
  slotKey: string;
  accountRef: string;
  subagentId?: string;
  minimalAgent: boolean;
  workDir?: string;
  systemPrompt?: string;
  /** `worker.appliedSystemHistorySeed`: present means the ledger cannot be indexed. */
  appliedSystemHistorySeed?: string;
  registeredTools: ToolDefLike[];
  committedMessages: NormalizedMessage[];
  resumeSupported: boolean;
}

/** An entry held in RAM, ledger included. */
export interface ParkedSession {
  nativeSessionId: string;
  slotKey: string;
  accountRef: string;
  subagentId?: string;
  committedMessages: NormalizedMessage[];
  systemPrompt?: string;
  systemHistorySeed?: string;
  minimalAgent: boolean;
  registeredTools: ToolDefLike[];
  workDir?: string;
  resumeSupported: boolean;
  parkedAt: number;
  estimatedBytes: number;
}

/**
 * Exactly one resume ledger may be bound to a freshly started worker, and the
 * caller must know which shelf it came from and how much of the incoming
 * transcript it covers.
 */
export type ResolvedShelfResume =
  | {
      kind: "memory";
      entry: ParkedSession;
      matchedKey: string;
      matchedPrefixLength: number;
      viaSecondaryHash: boolean;
    }
  | {
      kind: "persisted";
      entry: PersistedParkedSession;
      matchedKey: string;
      matchedPrefixLength: number;
      viaSecondaryHash: boolean;
    };

/** A resume source that a live turn now owns, until `release()` is called. */
export type ClaimedShelfResume = ResolvedShelfResume & { release: () => void };

export interface ResolveShelfResumeParams {
  account: AccountDescriptor;
  req: NormalizedAnthropicRequest;
  /** Exact key the caller would use for this session (`slot::account::session[::sub:…]`). */
  sessionKey: string;
  requestedMinimalAgent: boolean;
  now?: number;
  /** False for the real `agy` runtime, which must also see the `.db` on disk. */
  hasCustomSpawnFn: boolean;
  /** Keys currently owned by a live turn/worker; never adopted for reuse. */
  isKeyBusy?: (key: string) => boolean;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

export function estimateParkedBytes(
  messages: NormalizedMessage[],
  systemPrompt: string | undefined,
  systemHistorySeed: string | undefined,
  tools: ToolDefLike[],
): number {
  let bytes =
    (systemPrompt ? utf8Bytes(systemPrompt) : 0) +
    (systemHistorySeed ? utf8Bytes(systemHistorySeed) : 0);
  try {
    bytes += utf8Bytes(JSON.stringify(tools));
    bytes += utf8Bytes(JSON.stringify(messages));
  } catch {
    bytes += 64 * 1024;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Synchronous bounded file lock
// ---------------------------------------------------------------------------

/**
 * Blocks the current thread for `ms`. A shelf mutation happens at most once per
 * finished turn, and the critical section is a few kilobytes of JSON, so a
 * short synchronous wait is both simpler and safer than an async lock that could
 * interleave with a turn's teardown.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      /* spin: SharedArrayBuffer unavailable */
    }
  }
}

const LOCK_STALE_MS = 15_000;
const LOCK_POLL_MS = 5;
/**
 * How long a caller waits for the shelf lock. A lost update is unrecoverable
 * (it can resurrect an invalidated checkpoint), so waiting is always preferable
 * to writing from a stale snapshot — but a wedged holder must not stall a turn
 * forever, so the wait is bounded and the caller fails closed.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

function tryPublishLock(lockPath: string, token: string): boolean {
  const staging = `${lockPath}.${process.pid}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  try {
    fs.writeFileSync(staging, `${token}\n`, { mode: 0o600 });
  } catch {
    return false;
  }
  try {
    fs.linkSync(staging, lockPath);
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    // Filesystems without hardlinks: exclusive create is the fallback.
    if (
      err?.code === "EXDEV" ||
      err?.code === "EPERM" ||
      err?.code === "ENOSYS" ||
      err?.code === "EACCES"
    ) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        try {
          fs.writeSync(fd, `${token}\n`);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch {
        // `EEXIST` (someone else won the race) and an unwritable directory mean
        // the same thing to the caller: this writer did not publish the lock.
        return false;
      }
    }
    return false;
  } finally {
    try {
      fs.unlinkSync(staging);
    } catch {}
  }
}

/**
 * Best-effort stale-lock reclamation, once the lock is seen unchanged twice.
 *
 * A lock naming a live PID is never reclaimed, however old it is: its owner is
 * still inside the critical section (a slow disk can easily exceed any age
 * threshold), and unlinking it would hand the same section to a second writer.
 * Only a lock whose owner is demonstrably gone — a dead PID, or no PID at all —
 * is removed, and age is the fallback only when the file carries no usable PID.
 */
function reclaimStaleLock(lockPath: string): void {
  let first: { token: string; pid: number; mtimeMs: number } | null = null;
  try {
    const token = fs.readFileSync(lockPath, "utf8").trim();
    const stat = fs.statSync(lockPath);
    first = {
      token,
      pid: Number(token.split(":")[0]),
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return;
  }
  if (!first.token) return;

  const hasValidPid = Number.isInteger(first.pid) && first.pid > 1;
  if (hasValidPid) {
    // Never steal a live owner's lock.
    if (isPidAlive(first.pid)) return;
  } else if (Date.now() - first.mtimeMs <= LOCK_STALE_MS) {
    // No usable PID: age is the only evidence we have.
    return;
  }

  // Jitter, then re-read: only the process that still sees the same dead token
  // removes it, so two reclaimers cannot both take the lock.
  sleepSync(5 + Math.floor(Math.random() * 10));
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() !== first.token) return;
    fs.unlinkSync(lockPath);
  } catch {}
}

function acquireShelfLock(
  lockPath: string,
  token: string,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (tryPublishLock(lockPath, token)) return true;
    reclaimStaleLock(lockPath);
    if (tryPublishLock(lockPath, token)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(LOCK_POLL_MS);
  }
}

function releaseShelfLock(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() === token) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

/**
 * Runs `fn` while holding `<filePath>.lock`, or reports that it could not.
 *
 * `fn` is never run without the lock: the resume index is a read-modify-write of
 * a whole map, so an unlocked run does not merely "lose a hint", it can overwrite
 * a concurrent writer's entries or resurrect a checkpoint another process just
 * invalidated. A caller that cannot take the lock has to fail closed
 * (`{ ok: false }`) and let the caller keep the live worker instead.
 */
export function withShelfFileLockSync<T>(
  filePath: string,
  fn: () => T,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): { ok: true; value: T } | { ok: false } {
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  if (!acquireShelfLock(lockPath, token, timeoutMs)) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseShelfLock(lockPath, token);
  }
}

// ---------------------------------------------------------------------------
// Shelf store
// ---------------------------------------------------------------------------

interface ShelfFileCache {
  file: string;
  mtimeMs: number;
  size: number;
}

export class ShelfStore {
  private readonly parkedSessions = new Map<string, ParkedSession>();
  private persistedSessions = new Map<string, PersistedParkedSession>();
  private cache: ShelfFileCache | null = null;
  /**
   * Native session ids handed to a live turn by `claimResume`. Until the claim
   * is released, no lookup may offer the same native session again: two
   * concurrent forks resuming one `agy` conversation would corrupt it.
   */
  private readonly reservedNativeIds = new Set<string>();
  /**
   * True when the last `ensureLoaded` could not read a shelf file that exists.
   * The in-memory map is then *not* evidence that nothing is on disk.
   */
  private shelfLoadFailed = false;

  // -------------------------------------------------------------------------
  // Memory shelf
  // -------------------------------------------------------------------------

  /**
   * The live memory shelf, for callers that already hold its contract and for
   * white-box tests.
   */
  get memorySessions(): Map<string, ParkedSession> {
    return this.parkedSessions;
  }

  /** The live digest index, for callers that only need to look entries up. */
  get persistedSessionsMap(): Map<string, PersistedParkedSession> {
    return this.persistedSessions;
  }

  /** The index file the shelf last resolved (`null` when no data root exists). */
  get loadedFile(): string | null {
    return this.cache?.file ?? null;
  }

  // -------------------------------------------------------------------------
  // Persisted file I/O
  // -------------------------------------------------------------------------

  private shelfFile(): string | null {
    try {
      return path.join(getPluginDataRoot(), SHELF_FILE_NAME);
    } catch {
      return null;
    }
  }

  private invalidateLoadedCache(): void {
    this.cache = null;
  }

  /**
   * Reloads the on-disk index when the file changed since the last read.
   *
   * A `mtime`/size check is enough here: the file is only ever replaced by an
   * atomic rename, so any write by another process shows up as a new inode's
   * metadata on the next call.
   */
  ensureLoaded(now = Date.now()): void {
    const file = this.shelfFile();
    if (!file) {
      this.persistedSessions = new Map();
      this.cache = null;
      this.shelfLoadFailed = false;
      return;
    }

    let mtimeMs = 0;
    let size = -1;
    try {
      const stat = fs.statSync(file);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      // No file yet (or unreadable): nothing to resume from. The map is always
      // cleared, because a data-root change leaves entries that belonged to the
      // previous file — keeping them would resurrect another root's checkpoints.
      this.persistedSessions = new Map();
      this.cache = { file, mtimeMs: 0, size: -1 };
      this.shelfLoadFailed = false;
      return;
    }

    if (
      this.cache &&
      this.cache.file === file &&
      this.cache.mtimeMs === mtimeMs &&
      this.cache.size === size
    ) {
      return;
    }

    let next: Map<string, PersistedParkedSession>;
    let loadFailed = false;
    try {
      next = this.parseSessionsFile(file);
    } catch (err: any) {
      next = new Map();
      // `ENOENT` means the file is gone, so an empty map is the truth. Anything
      // else (a truncated or unreadable file) makes it a guess, and a guess must
      // never be read as "there is no checkpoint on disk".
      loadFailed = err?.code !== "ENOENT";
    }
    this.persistedSessions = next;
    this.shelfLoadFailed = loadFailed;
    this.cache = { file, mtimeMs, size };
    this.prunePersisted(now);
  }

  /**
   * Reads a shelf file as a session map. Throws when the file cannot be read or
   * is not JSON, so each caller decides what that means for it.
   */
  private parseSessionsFile(
    file: string,
  ): Map<string, PersistedParkedSession> {
    const parsed: any = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = new Map<string, PersistedParkedSession>();
    const sessions = parsed?.sessions;
    if (!sessions || typeof sessions !== "object") return out;
    for (const [key, raw] of Object.entries(
      sessions as Record<string, unknown>,
    )) {
      const entry = normalizePersistedEntry(raw);
      if (entry) out.set(key, entry);
    }
    return out;
  }

  /** Reads the on-disk index fresh, without touching the in-memory cache. */
  private readDiskSessions(file: string): Map<string, PersistedParkedSession> {
    try {
      return this.parseSessionsFile(file);
    } catch {
      // No file (or an unreadable one) is an empty index for a mutation: the
      // caller's entry is added to whatever can be read, and the write either
      // lands or reports failure.
      return new Map();
    }
  }

  private prunePersistedMap(
    map: Map<string, PersistedParkedSession>,
    now: number,
  ): void {
    for (const [key, entry] of map) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) map.delete(key);
    }
    while (map.size > MAX_PERSISTED_PARKED_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of map) {
        if (entry.parkedAt < oldestAt) {
          oldestAt = entry.parkedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }

  private writeDiskSessions(
    file: string,
    map: Map<string, PersistedParkedSession>,
  ): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {}
    const payload = JSON.stringify(
      { version: 1, sessions: Object.fromEntries(map) },
      null,
      2,
    );
    const tmp = `${file}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {}
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {}
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw err;
    }
  }

  /**
   * Applies one incremental mutation to the on-disk index under the file lock.
   * The snapshot is re-read inside the lock, so a concurrent writer's entries and
   * invalidations are preserved.
   *
   * Returns whether the mutation reached the disk. Every caller reports that
   * back to a turn that is deciding whether it may close a worker, so a lock
   * timeout, an unwritable directory or `ENOSPC` must read as "not retained".
   */
  private mutateDiskSessions(
    mutate: (map: Map<string, PersistedParkedSession>) => void,
    now: number,
  ): boolean {
    const file = this.shelfFile();
    if (!file) return false;
    try {
      const result = withShelfFileLockSync(file, () => {
        const map = this.readDiskSessions(file);
        mutate(map);
        this.prunePersistedMap(map, now);
        this.writeDiskSessions(file, map);
        return map;
      });
      if (!result.ok) return false;
      this.persistedSessions = new Map(result.value);
      this.shelfLoadFailed = false;
      return true;
    } catch {
      return false;
    } finally {
      // Force a metadata re-read on the next `ensureLoaded`.
      this.invalidateLoadedCache();
    }
  }

  private prunePersisted(now = Date.now()): void {
    this.prunePersistedMap(this.persistedSessions, now);
  }

  // -------------------------------------------------------------------------
  // Snapshot → entry conversion
  // -------------------------------------------------------------------------

  private canPersist(snapshot: WorkerParkSnapshot): boolean {
    return (
      snapshot.resumeSupported &&
      !snapshot.appliedSystemHistorySeed &&
      !snapshot.sessionId.startsWith("ephemeral-") &&
      Boolean(snapshot.nativeSessionId)
    );
  }

  private persistedEntryFrom(
    snapshot: WorkerParkSnapshot,
    now: number,
  ): PersistedParkedSession {
    const entry: PersistedParkedSession = {
      nativeSessionId: snapshot.nativeSessionId,
      accountRef: snapshot.accountRef,
      slotKey: snapshot.slotKey,
      minimalAgent: snapshot.minimalAgent,
      workDir: snapshot.workDir,
      parkedAt: now,
      systemPromptDigest: sha256Hex(stripVolatileSystem(snapshot.systemPrompt ?? "")),
      toolsDigests: digestToolsForPersistence(snapshot.registeredTools),
      messageDigests: digestMessagesForPersistence(snapshot.committedMessages),
      heardRuns: heardRuns(snapshot.committedMessages, true),
    };
    if (snapshot.subagentId) entry.subagentId = snapshot.subagentId;
    return entry;
  }

  // -------------------------------------------------------------------------
  // Public mutations
  // -------------------------------------------------------------------------

  /**
   * Saves a worker's session to the memory and/or persisted shelves.
   *
   * Returns whether at least one usable resume source was retained: a caller
   * about to close the worker must not treat an oversized, seeded ledger as
   * recoverable when neither shelf accepted it.
   */
  park(
    sessionKey: string,
    snapshot: WorkerParkSnapshot,
    now = Date.now(),
  ): boolean {
    this.prune(now);

    let persistedRetained = false;
    if (this.canPersist(snapshot)) {
      persistedRetained = this.recordPersisted(sessionKey, snapshot, now);
    }

    let memoryRetained = false;
    if (snapshot.nativeSessionId) {
      const estimatedBytes = estimateParkedBytes(
        snapshot.committedMessages,
        snapshot.systemPrompt,
        snapshot.appliedSystemHistorySeed,
        snapshot.registeredTools,
      );
      this.parkedSessions.delete(sessionKey);
      if (estimatedBytes <= MAX_SINGLE_PARKED_BYTES) {
        const parked: ParkedSession = {
          nativeSessionId: snapshot.nativeSessionId,
          slotKey: snapshot.slotKey,
          accountRef: snapshot.accountRef,
          committedMessages: [...snapshot.committedMessages],
          systemPrompt: snapshot.systemPrompt,
          systemHistorySeed: snapshot.appliedSystemHistorySeed,
          minimalAgent: snapshot.minimalAgent,
          registeredTools: [...snapshot.registeredTools],
          workDir: snapshot.workDir,
          resumeSupported: snapshot.resumeSupported,
          parkedAt: now,
          estimatedBytes,
        };
        if (snapshot.subagentId) parked.subagentId = snapshot.subagentId;
        this.parkedSessions.set(sessionKey, parked);
        this.prune(now);
        memoryRetained = this.parkedSessions.has(sessionKey);
      }
    }

    return memoryRetained || persistedRetained;
  }

  /**
   * Records a digest-only index entry for a session that can be woken with
   * `session/resume`. Returns whether an entry for this session now exists.
   */
  recordPersisted(
    sessionKey: string,
    snapshot: WorkerParkSnapshot,
    now = Date.now(),
  ): boolean {
    if (!this.canPersist(snapshot)) return false;
    this.ensureLoaded(now);
    const entry = this.persistedEntryFrom(snapshot, now);
    const written = this.mutateDiskSessions((map) => {
      // Re-keying a session (first-turn id drift) must not leave a ghost.
      for (const [key, existing] of map) {
        if (key === sessionKey) {
          map.delete(key);
          continue;
        }
        if (existing.nativeSessionId === entry.nativeSessionId) map.delete(key);
      }
      map.set(sessionKey, entry);
    }, now);
    // Honest by construction: only a write that landed counts. A lock timeout,
    // a read-only data root or `ENOSPC` leaves the index alone and reports
    // `false`, even when an *older* entry for this key is still on disk — the
    // caller is about to close a worker on the strength of this answer, and a
    // stale checkpoint is not a resume source for the ledger it just produced.
    if (!written) return false;
    return this.persistedSessions.has(sessionKey);
  }

  /**
   * Drops a session from the persisted index by key and/or native id. Called
   * *before* a native session advances, so an interrupted turn can never leave an
   * older checkpoint falsely eligible for resume.
   */
  invalidate(sessionKey: string, nativeSessionId?: string, now = Date.now()): boolean {
    this.ensureLoaded(now);
    const holds = (key: string, entry: PersistedParkedSession): boolean =>
      key === sessionKey ||
      (nativeSessionId !== undefined && entry.nativeSessionId === nativeSessionId);
    const inMemory = [...this.persistedSessions].some(([key, entry]) => holds(key, entry));
    // Nothing in the loaded index *and* a shelf that was read cleanly (or does
    // not exist): there is no checkpoint anywhere, so there is nothing to fail.
    if (!inMemory && !this.shelfLoadFailed) return true;
    // A caller about to advance a native session must know whether an older
    // checkpoint can still be resumed. Deleting from RAM without deleting it
    // from disk would hide exactly the checkpoint that must not be reused.
    const ok = this.mutateDiskSessions((map) => {
      for (const [key, entry] of map) {
        if (holds(key, entry)) map.delete(key);
      }
    }, now);
    if (!ok) return false;
    for (const [key, entry] of this.persistedSessions) {
      if (holds(key, entry)) this.persistedSessions.delete(key);
    }
    return true;
  }

  /** Removes the memory entry that was just consumed for a resume. */
  consumeMemory(matchedKey: string, nativeSessionId?: string): void {
    this.parkedSessions.delete(matchedKey);
    if (!nativeSessionId) return;
    for (const [key, entry] of this.parkedSessions) {
      if (entry.nativeSessionId === nativeSessionId) this.parkedSessions.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Pruning / protection
  // -------------------------------------------------------------------------

  prune(now = Date.now()): void {
    let totalBytes = 0;
    for (const [key, entry] of this.parkedSessions) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) {
        this.parkedSessions.delete(key);
      } else {
        totalBytes += entry.estimatedBytes;
      }
    }
    while (
      this.parkedSessions.size > MAX_PARKED_SESSIONS ||
      totalBytes > MAX_TOTAL_PARKED_BYTES
    ) {
      const oldestKey = this.parkedSessions.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      const victim = this.parkedSessions.get(oldestKey);
      this.parkedSessions.delete(oldestKey);
      if (victim) {
        totalBytes = Math.max(0, totalBytes - victim.estimatedBytes);
      }
    }
  }

  /** Native ids the storage GC must never delete. */
  collectProtectedNativeSessionIds(now = Date.now()): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.parkedSessions.values()) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) continue;
      if (entry.nativeSessionId) ids.add(entry.nativeSessionId);
    }
    this.ensureLoaded(now);
    for (const entry of this.persistedSessions.values()) {
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) continue;
      if (entry.nativeSessionId) ids.add(entry.nativeSessionId);
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Resume resolution
  // -------------------------------------------------------------------------

  /**
   * Finds exactly one resume ledger for this request, preferring the exact
   * session key and falling back to a secondary content-hash lookup.
   *
   * An incompatible memory entry at the exact key is deleted on the spot: a
   * stale ledger must never be left where the next request could trust it.
   */
  resolveResume(params: ResolveShelfResumeParams): ResolvedShelfResume | null {
    const now = params.now ?? Date.now();
    const { req, sessionKey } = params;

    // 1. Exact memory key.
    const parked = this.parkedSessions.get(sessionKey);
    if (parked) {
      const result = this.matchMemoryEntry(parked, params, now);
      if (result) {
        return {
          kind: "memory",
          entry: parked,
          matchedKey: sessionKey,
          matchedPrefixLength: result.incomingPrefixLength,
          viaSecondaryHash: false,
        };
      }
      this.parkedSessions.delete(sessionKey);
    }

    // 2. Exact persisted key.
    this.ensureLoaded(now);
    const persisted = this.persistedSessions.get(sessionKey);
    if (persisted) {
      const result = this.matchPersistedEntry(persisted, params, now);
      if (result) {
        return {
          kind: "persisted",
          entry: persisted,
          matchedKey: sessionKey,
          matchedPrefixLength: result.incomingPrefixLength,
          viaSecondaryHash: false,
        };
      }
    }

    // 3. Secondary content-hash lookup: a caller with no session header (or a
    //    client that rotated its id) still continues its own conversation, as
    //    long as exactly one compatible ledger covers a strict prefix of it.
    if (req.sessionId === null) return null;
    if (req.toolChoice?.type === "none") return null;

    const memoryHit = this.bestMemoryCandidate(params, now);
    if (memoryHit) return memoryHit;
    return this.bestPersistedCandidate(params, now);
  }

  /**
   * `resolveResume` plus ownership: the returned resume source is reserved, so a
   * concurrent fork cannot be handed the same native session, and the shelf
   * entries it came from are already consumed.
   *
   * `release` must be called once the worker exists (or the adoption failed).
   * Returns `null` — never a half-claim — when the disk could not be updated; a
   * cold start is always safe, resuming a conversation twice never is.
   */
  claimResume(params: ResolveShelfResumeParams): ClaimedShelfResume | null {
    const now = params.now ?? Date.now();
    // A second pass only happens when the persisted entry we matched vanished
    // between the lookup and the lock (another host claimed it first).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const hit = this.resolveResume({ ...params, now });
      if (!hit) return null;
      const nativeSessionId = hit.entry.nativeSessionId;
      this.reservedNativeIds.add(nativeSessionId);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.reservedNativeIds.delete(nativeSessionId);
      };

      if (hit.kind === "memory") {
        this.consumeMemory(hit.matchedKey, nativeSessionId);
        // A secondary match means the entry sits under another key; the memory
        // shelf and the index must both stop offering it.
        if (hit.viaSecondaryHash) this.invalidate(hit.matchedKey, nativeSessionId, now);
        return { ...hit, release };
      }

      const removed = this.removePersistedEntry(hit.matchedKey, nativeSessionId, now);
      if (removed === "failed") {
        // Lock timeout or an unwritable index: fail closed.
        this.reservedNativeIds.delete(nativeSessionId);
        return null;
      }
      this.consumeMemory(hit.matchedKey, nativeSessionId);
      if (removed === "gone") {
        // Another host took it; a fresh lookup may find a different candidate.
        this.reservedNativeIds.delete(nativeSessionId);
        continue;
      }
      return { ...hit, release };
    }
    return null;
  }

  /**
   * Removes one persisted entry under the shelf lock, but only if it still
   * describes `nativeSessionId` — the reservation and the delete have to be one
   * atomic step for two hosts racing on the same checkpoint.
   */
  private removePersistedEntry(
    matchedKey: string,
    nativeSessionId: string,
    now: number,
  ): "removed" | "gone" | "failed" {
    const file = this.shelfFile();
    if (!file) return "failed";
    try {
      const result = withShelfFileLockSync(file, () => {
        const map = this.readDiskSessions(file);
        const current = map.get(matchedKey);
        if (!current || current.nativeSessionId !== nativeSessionId) {
          return "gone" as const;
        }
        for (const [key, entry] of map) {
          if (key === matchedKey || entry.nativeSessionId === nativeSessionId) {
            map.delete(key);
          }
        }
        this.prunePersistedMap(map, now);
        this.writeDiskSessions(file, map);
        return map;
      });
      if (!result.ok) return "failed";
      if (typeof result.value === "string") return "gone";
      this.persistedSessions = new Map(result.value);
      this.shelfLoadFailed = false;
      return "removed";
    } catch {
      return "failed";
    } finally {
      this.invalidateLoadedCache();
    }
  }

  /**
   * The identity checks every shelf entry shares before its ledger is compared.
   *
   * At the exact key the entry already belongs to this session, so a tag an
   * older entry never recorded is not disqualifying — a *conflicting* one is.
   * The cross-key secondary lookup is strict instead: adopting another
   * session's native conversation across accounts, slots or subagents would
   * replay this conversation into the wrong agent.
   */
  private entryIdentityAllows(
    fields: {
      slotKey?: string;
      accountRef?: string;
      subagentId?: string;
      minimalAgent: boolean;
      workDir?: string;
    },
    params: ResolveShelfResumeParams,
    strict: boolean,
    subagent: "ignore" | "conflict" | "strict",
  ): boolean {
    const { req, account, requestedMinimalAgent } = params;
    if (fields.minimalAgent !== requestedMinimalAgent) return false;
    if (normalizeWorkDir(fields.workDir) !== normalizeWorkDir(req.workDir)) {
      return false;
    }
    const expectedSubagent = req.subagentId ?? undefined;
    const recordedSubagent = fields.subagentId ?? undefined;
    if (subagent === "strict" && recordedSubagent !== expectedSubagent) {
      return false;
    }
    if (
      subagent === "conflict" &&
      recordedSubagent !== undefined &&
      recordedSubagent !== expectedSubagent
    ) {
      return false;
    }
    if (strict) {
      return (
        fields.slotKey === account.slotKey &&
        fields.accountRef === account.accountRef
      );
    }
    if (fields.slotKey !== undefined && fields.slotKey !== account.slotKey) {
      return false;
    }
    return (
      fields.accountRef === undefined || fields.accountRef === account.accountRef
    );
  }

  private matchMemoryEntry(
    entry: ParkedSession,
    params: ResolveShelfResumeParams,
    now: number,
  ): PrefixMatchResult | null {
    const { req } = params;
    if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) return null;
    if (this.reservedNativeIds.has(entry.nativeSessionId)) return null;
    if (!this.entryIdentityAllows(entry, params, false, "ignore")) return null;
    if (!systemPromptsMatch(entry.systemPrompt, req.system)) return null;
    if (!isToolSetCompatible(entry.registeredTools, req.tools)) return null;
    const match = matchLedgerPrefix(entry.committedMessages, req.messages);
    return match.matched ? match : null;
  }

  private matchPersistedEntry(
    entry: PersistedParkedSession,
    params: ResolveShelfResumeParams,
    now: number,
  ): PrefixMatchResult | null {
    const { req } = params;
    if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) return null;
    if (this.reservedNativeIds.has(entry.nativeSessionId)) return null;
    // A `0.1.4` entry carries neither slot nor subagent tag; at its exact key it
    // still belongs to this session, so a missing value is tolerated.
    if (!this.entryIdentityAllows(entry, params, false, "conflict")) return null;
    if (entry.systemPromptDigest !== sha256Hex(stripVolatileSystem(req.system))) {
      return null;
    }
    if (!toolsMatchPersistedDigests(entry.toolsDigests, req.tools)) return null;
    const match = matchPersistedPrefix(entry, req.messages);
    if (!match.matched) return null;
    if (!params.hasCustomSpawnFn && !this.conversationDbExists(params.account, entry.nativeSessionId)) {
      return null;
    }
    return match;
  }

  private conversationDbExists(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): boolean {
    try {
      const dbPath = resolveConversationDbPath(account, nativeSessionId);
      return Boolean(dbPath && fs.existsSync(dbPath));
    } catch {
      return false;
    }
  }

  /**
   * The entry covering the longest strict prefix of the request among the shelf
   * entries no live turn owns (newest wins ties).
   *
   * `compatible` is the shelf-specific half of the question — what "the same
   * session" means for a full-text memory ledger versus a digest index — and
   * returns the incoming prefix length it covers, or `null` when it cannot serve
   * this request at all.
   */
  private bestCandidate<E extends { nativeSessionId: string; parkedAt: number }>(
    entries: Iterable<readonly [string, E]>,
    params: ResolveShelfResumeParams,
    now: number,
    compatible: (key: string, entry: E) => number | null,
  ): { key: string; entry: E; length: number } | null {
    let best: { key: string; entry: E; length: number } | null = null;
    for (const [key, entry] of entries) {
      if (key === params.sessionKey) continue;
      if (params.isKeyBusy?.(key)) continue;
      if (now - entry.parkedAt >= PARKED_SESSION_TTL_MS) continue;
      if (this.reservedNativeIds.has(entry.nativeSessionId)) continue;
      const length = compatible(key, entry);
      if (length === null) continue;
      // A strict prefix: an entry that already covers the whole request leaves
      // no new turn to run, so it is not this request's session.
      if (length >= params.req.messages.length) continue;
      if (!best || length > best.length) best = { key, entry, length };
    }
    return best;
  }

  /** Longest strict prefix among compatible memory entries (newest wins ties). */
  private bestMemoryCandidate(
    params: ResolveShelfResumeParams,
    now: number,
  ): ResolvedShelfResume | null {
    const { req } = params;
    const best = this.bestCandidate(
      this.parkedSessions,
      params,
      now,
      (_key, entry) => {
        if (!this.entryIdentityAllows(entry, params, true, "strict")) {
          return null;
        }
        if (!systemPromptsMatch(entry.systemPrompt, req.system)) return null;
        if (!isToolSetCompatible(entry.registeredTools, req.tools)) return null;
        if (entry.committedMessages.length < 2) return null;
        const match = matchLedgerPrefix(entry.committedMessages, req.messages);
        return match.matched ? match.incomingPrefixLength : null;
      },
    );
    if (!best) return null;
    return {
      kind: "memory",
      entry: best.entry,
      matchedKey: best.key,
      matchedPrefixLength: best.length,
      viaSecondaryHash: true,
    };
  }

  /** Longest strict prefix among compatible persisted entries (newest wins ties). */
  private bestPersistedCandidate(
    params: ResolveShelfResumeParams,
    now: number,
  ): ResolvedShelfResume | null {
    const { req } = params;
    const expectedPromptDigest = sha256Hex(stripVolatileSystem(req.system));
    const best = this.bestCandidate(
      this.persistedSessions,
      params,
      now,
      (key, entry) => {
        // Cross-key adoption must be strict: a legacy entry that recorded no
        // slot or subagent may still resume at its exact key, never across
        // boundaries — and the key itself has to name this subagent.
        if (!this.entryIdentityAllows(entry, params, true, "strict")) {
          return null;
        }
        if (subagentIdFromSessionKey(key) !== (req.subagentId ?? undefined)) {
          return null;
        }
        if (entry.systemPromptDigest !== expectedPromptDigest) return null;
        if (!toolsMatchPersistedDigests(entry.toolsDigests, req.tools)) {
          return null;
        }
        if (entry.messageDigests.length < 2) return null;
        const match = matchPersistedPrefix(entry, req.messages);
        if (!match.matched) return null;
        if (
          !params.hasCustomSpawnFn &&
          !this.conversationDbExists(params.account, entry.nativeSessionId)
        ) {
          return null;
        }
        return match.incomingPrefixLength;
      },
    );
    if (!best) return null;
    return {
      kind: "persisted",
      entry: best.entry,
      matchedKey: best.key,
      matchedPrefixLength: best.length,
      viaSecondaryHash: true,
    };
  }
}
