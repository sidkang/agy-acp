import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDescriptor } from "../types";

// Capture host startup environment ONCE at module load
export const HOST_HOME = process.env.HOME;
export const HOST_XDG_DATA_HOME = process.env.XDG_DATA_HOME;
export const HOST_PATH = process.env.PATH ?? "";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the plugin data root directory.
 * Respects ANTIGRAVITY_MAGPIE_DATA_DIR if set (useful for tests!),
 * else falls back to $XDG_DATA_HOME/antigravity-magpie or ~/.local/share/antigravity-magpie.
 * Ensures the directory exists with mode 0o700.
 */
export function getPluginDataRoot(): string {
  const root =
    process.env.AGY_ACP_DATA_DIR ||
    process.env.ANTIGRAVITY_MAGPIE_DATA_DIR ||
    (HOST_XDG_DATA_HOME
      ? path.join(HOST_XDG_DATA_HOME, "agy-acp")
      : path.join(HOST_HOME || os.homedir(), ".local", "share", "agy-acp"));

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {}
  return root;
}

/**
 * Ensures the browser-suppression shim directory exists with executable
 * `open` and `xdg-open` (and `open.cmd` on win32) that immediately exit 1.
 */
export function getBrowserShimDir(): string {
  const shimDir = path.join(getPluginDataRoot(), "bin-shims");
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o755 });

  if (process.platform === "win32") {
    const openCmd = path.join(shimDir, "open.cmd");
    if (!fs.existsSync(openCmd)) {
      fs.writeFileSync(openCmd, "@exit /b 1\r\n", { mode: 0o755 });
    }
  } else {
    for (const name of ["open", "xdg-open"]) {
      const filePath = path.join(shimDir, name);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      } else {
        try {
          fs.chmodSync(filePath, 0o755);
        } catch {}
      }
    }
  }
  return shimDir;
}

/**
 * Resolves the path to the `agy` binary.
 * Checks AGY_PATH env var, then searches PATH and standard locations.
 * Throws a clear Error if not found.
 */
export function resolveAgyBinary(): string {
  if (process.env.AGY_PATH) {
    const custom = process.env.AGY_PATH;
    if (fs.existsSync(custom)) {
      return custom;
    }
    throw new Error(`AGY_PATH set to '${custom}' but file does not exist`);
  }

  const windows = process.platform === "win32";
  const names = windows ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
  const pathsToSearch: string[] = [];

  const pathEnv = process.env.PATH || HOST_PATH;
  if (pathEnv) {
    pathsToSearch.push(...pathEnv.split(path.delimiter).filter(Boolean));
  }

  const home = HOST_HOME || os.homedir();
  if (windows) {
    pathsToSearch.push(
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agy", "bin"),
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Antigravity", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".gemini", "bin")
    );
  } else {
    pathsToSearch.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".gemini", "bin")
    );
  }

  for (const dir of pathsToSearch) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }

  throw new Error("Antigravity CLI (agy) binary not found. Please install agy or set AGY_PATH.");
}

/**
 * Resolves isolated home directory for an account reference.
 * Strictly validates that accountRef is a UUID to prevent path traversal.
 * Ensures the directory and `.gemini/antigravity-cli` exist with mode 0o700.
 */
export function resolveIsolatedHomeDir(accountRef: string): string {
  if (!UUID_REGEX.test(accountRef)) {
    throw new Error(`Invalid accountRef '${accountRef}': must be a valid UUID`);
  }
  const root = getPluginDataRoot();
  const accountDir = path.join(root, "accounts", accountRef.toLowerCase());
  const geminiDir = path.join(accountDir, ".gemini");
  const agyCliDir = path.join(geminiDir, "antigravity-cli");

  fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(accountDir, 0o700);
    fs.chmodSync(geminiDir, 0o700);
    fs.chmodSync(agyCliDir, 0o700);
  } catch {}

  return accountDir;
}

export interface SpawnAgyOptions {
  cwd?: string;
  extraEnv?: Record<string, string>;
}

const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/**
 * Appends the loopback hosts to a NO_PROXY-style string, preserving existing
 * comma-separated entries and never duplicating one (case-insensitively).
 */
function withLoopbackNoProxy(current: string | undefined): string {
  const existing = typeof current === "string" ? current : "";
  const seen = new Set(
    existing
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  const missing = LOOPBACK_NO_PROXY_HOSTS.filter((host) => !seen.has(host));
  if (missing.length === 0) return existing;
  const base = existing.replace(/[\s,]+$/, "");
  return base ? `${base},${missing.join(",")}` : missing.join(",");
}

/**
 * Copies MAGPIE_* proxy variables into the conventional proxy variables when
 * neither the upper- nor lower-case form is set. This lets background work
 * outside Magpie's `via` proxy context (usage refreshes, model probes) use the
 * proxy configured for the plugin.
 */
function applyMagpieProxyFallbacks(env: NodeJS.ProcessEnv): void {
  const pairs: Array<[string, string, string]> = [
    ["HTTPS_PROXY", "https_proxy", "MAGPIE_HTTPS_PROXY"],
    ["HTTP_PROXY", "http_proxy", "MAGPIE_HTTP_PROXY"],
    ["ALL_PROXY", "all_proxy", "MAGPIE_ALL_PROXY"],
  ];
  for (const [upper, lower, magpieKey] of pairs) {
    const upperValue = env[upper];
    const lowerValue = env[lower];
    if (typeof upperValue === "string" && upperValue.trim() !== "") continue;
    if (typeof lowerValue === "string" && lowerValue.trim() !== "") continue;
    const fallback = process.env[magpieKey];
    if (typeof fallback === "string" && fallback.trim() !== "") {
      env[upper] = fallback;
    }
  }
}

/**
 * Builds the environment and arguments for spawning `agy`.
 * - Resolves `bin = resolveAgyBinary()` before modifying PATH.
 * - Deletes cross-contaminating vars.
 * - Prepends browser-suppression shim directory to PATH.
 * - Sets BROWSER="/usr/bin/false" and AGY_CLI_DISABLE_AUTO_UPDATE.
 * - If isolated: sets HOME, SSH_CONNECTION, XDG dirs, and adds --gemini-dir/--app-data-dir only for acp.
 * - If host: keeps HOST_HOME and inherited SSH_* unchanged.
 */
export function buildAgyEnvAndArgs(
  account: AccountDescriptor,
  args: string[],
  options?: SpawnAgyOptions
): { bin: string; finalArgs: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  const bin = resolveAgyBinary();
  const shimDir = getBrowserShimDir();

  const env: NodeJS.ProcessEnv = { ...process.env };

  // Bun exposes proxy variables as non-enumerable process.env accessors, so a
  // plain spread drops them. Copy them explicitly before applying defaults.
  for (const key of [
    "NO_PROXY",
    "no_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }

  // Delete cross-contaminating vars
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.ANTIGRAVITY_APP_DATA_DIR;
  delete env.ANTIGRAVITY_CONFIG_REL_DIR;

  // Windows environment variables are case-insensitive, while Node exposes
  // whichever spelling the parent used. Collapse every `Path` spelling into the
  // canonical `PATH` before the browser shim is prepended.
  if (account.mode === "isolated" && process.platform === "win32") {
    const pathValues: string[] = [];
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() !== "PATH") continue;
      const value = env[key];
      if (typeof value === "string" && value) pathValues.push(value);
      delete env[key];
    }
    if (pathValues.length > 0) env.PATH = pathValues[0];
  }

  // Browser suppression & auto-update
  env.PATH = `${shimDir}${path.delimiter}${env.PATH ?? HOST_PATH}`;
  env.BROWSER = "/usr/bin/false";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? "true";

  const finalArgs = [...args];
  let cwd: string;

  if (account.mode === "isolated") {
    const home = account.isolatedHomeDir ?? resolveIsolatedHomeDir(account.accountRef);
    env.HOME = home;
    // Windows resolves the user's home from USERPROFILE, not HOME.
    env.USERPROFILE = home;
    // SSH_CONNECTION triggers agy's file-based token storage, bypassing Keychain / SecretService
    env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 22";
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    env.XDG_STATE_HOME = path.join(home, ".local", "state");

    if (finalArgs[0] === "acp") {
      const geminiDir = path.join(home, ".gemini");
      // agy launcher.go requires --gemini-dir to be absolute, while --app-data-dir
      // MUST be a relative subdirectory name under geminiDir ("must not be absolute").
      const appDataDir = "antigravity-cli";
      if (!finalArgs.includes("--gemini-dir")) {
        finalArgs.splice(1, 0, "--gemini-dir", geminiDir);
      }
      if (!finalArgs.includes("--app-data-dir")) {
        const geminiDirIdx = finalArgs.indexOf("--gemini-dir");
        const insertIdx = geminiDirIdx >= 0 ? geminiDirIdx + 2 : 1;
        finalArgs.splice(insertIdx, 0, "--app-data-dir", appDataDir);
      }
    }
    cwd = options?.cwd ?? home;
  } else {
    // Host mode: keep HOST_HOME and inherited SSH_* unchanged
    env.HOME = HOST_HOME ?? process.env.HOME ?? "";
    cwd = options?.cwd ?? (HOST_HOME || process.cwd());
  }

  if (options?.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  applyMagpieProxyFallbacks(env);

  // agy reaches the bridge's MCP server over loopback; a host HTTP proxy must
  // never intercept those calls. Apply this last so an extraEnv NO_PROXY still
  // keeps the required loopback entries.
  env.NO_PROXY = withLoopbackNoProxy(env.NO_PROXY);
  env.no_proxy = withLoopbackNoProxy(env.no_proxy);

  return { bin, finalArgs, env, cwd };
}

/**
 * Spawns an isolated or host `agy` child process with pipe stdio and detached process group.
 */
export function spawnAgy(
  account: AccountDescriptor,
  args: string[],
  options?: SpawnAgyOptions
): ChildProcessWithoutNullStreams {
  const { bin, finalArgs, env, cwd } = buildAgyEnvAndArgs(account, args, options);
  // Keep child inside the parent host's Unix session / Windows Job Object so
  // Magpie's StartTree process-group sweep reaps descendants even if the plugin
  // host is killed with SIGKILL.
  return spawn(bin, finalArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });
}

/**
 * True when `pid` refers to a running OS process (`pid > 1`). `EPERM` means
 * the process exists under a different user and is treated as alive.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function collectUnixDescendantsBottomUp(rootPid: number): number[] {
  try {
    const res = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], {
      encoding: "utf-8",
      timeout: 1_500,
    });
    if (!res.stdout) return [];
    const childrenByPpid = new Map<number, number[]>();
    for (const rawLine of res.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 1) continue;
      let list = childrenByPpid.get(ppid);
      if (!list) {
        list = [];
        childrenByPpid.set(ppid, list);
      }
      list.push(pid);
    }

    const ordered: number[] = [];
    const visited = new Set<number>([rootPid]);
    const visit = (pid: number) => {
      const kids = childrenByPpid.get(pid);
      if (kids) {
        for (const k of kids) {
          if (!visited.has(k)) {
            visited.add(k);
            visit(k);
            ordered.push(k);
          }
        }
      }
    };
    visit(rootPid);
    return ordered;
  } catch {
    return [];
  }
}

/**
 * Kills a child process and its descendant process tree cleanly without
 * signaling the caller's own process group.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child || !child.pid) return;
  if (child.exitCode !== null && child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  } else {
    const descendants = collectUnixDescendantsBottomUp(child.pid);
    for (const pid of descendants) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    try {
      child.kill(signal);
    } catch {
      try {
        process.kill(child.pid, signal);
      } catch {}
    }
  }
}

export interface ExecBoundedOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
}

const activeBoundedProbes = new Set<ChildProcess>();
let boundedExitHookRegistered = false;

function registerBoundedExitHookOnce(): void {
  if (boundedExitHookRegistered) return;
  boundedExitHookRegistered = true;
  process.once("exit", () => {
    for (const child of Array.from(activeBoundedProbes)) {
      try {
        killProcessTree(child, "SIGKILL");
      } catch {}
    }
    activeBoundedProbes.clear();
  });
}

/**
 * Executes `agy` with bounded output and timeout, killing the process tree on timeout/abort.
 * Resolves promptly without hanging on descendant open pipes.
 */
export function execAgyBounded(
  account: AccountDescriptor,
  args: string[],
  options?: ExecBoundedOptions
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const maxBytes = options?.maxBytes ?? 1024 * 1024;
    const signal = options?.signal;

    registerBoundedExitHookOnce();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgy(account, args, { cwd: options?.cwd, extraEnv: options?.extraEnv });
      activeBoundedProbes.add(child);
    } catch (err: any) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: err?.message ?? String(err),
        timedOut: false,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      activeBoundedProbes.delete(child);
      if (timer) clearTimeout(timer);
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      killProcessTree(child);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    };

    const onAbort = () => {
      timedOut = false;
      finish(null);
    };

    if (signal?.aborted) {
      finish(null);
      return;
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timedOut = true;
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        finish(null);
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        finish(null);
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", () => {
      finish(null);
    });

    child.on("exit", (code) => {
      // Drain brief descendants then finish
      setTimeout(() => finish(code), 50);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

/**
 * Redacts secrets from log messages and diagnostic outputs.
 * Redacts OAuth code, access_token, refresh_token, Bearer tokens, and /mcp/ tokens.
 */
export function redactSecrets(text: string): string {
  if (!text) return "";
  let out = String(text);
  // OAuth callback query parameters: (?|&)code=..., access_token=..., refresh_token=...
  out = out.replace(/(\b(?:code|access_token|refresh_token)=)[^&\s"'<>]+/gi, "$1[REDACTED]");
  // JSON key-value pairs
  out = out.replace(/(["'](?:access_token|refresh_token|code)["']\s*:\s*["'])[^"']+["']/gi, "$1[REDACTED]\"");
  // Bearer tokens
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_.~%+-]+/gi, "$1[REDACTED]");
  // Loopback MCP tokens (/mcp/<token>)
  out = out.replace(/(\/mcp\/)[A-Za-z0-9_-]+/gi, "$1[REDACTED]");
  // Google OAuth authorization code format e.g. 4/0A...
  out = out.replace(/\b4\/0A[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  // Google OAuth refresh token format e.g. 1//04...
  out = out.replace(/\b1\/\/[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  // Google OAuth access token format e.g. ya29....
  out = out.replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]");
  return out;
}

export interface StoredAgyOAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

/**
 * Reads file-backed OAuth credentials (`antigravity-oauth-token`) for an
 * isolated account (or a file-backed host account on Linux/SSH) if available.
 * Never throws; returns `null` when unavailable or stored in OS Keychain.
 */
export function readStoredAgyOAuthCredentials(
  account: AccountDescriptor,
): StoredAgyOAuthCredentials | null {
  try {
    const homeDir =
      account.mode === "isolated"
        ? (account.isolatedHomeDir ?? resolveIsolatedHomeDir(account.accountRef))
        : (HOST_HOME || os.homedir());
    if (!homeDir) return null;

    const tokenPath = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token",
    );
    if (!fs.existsSync(tokenPath)) return null;

    const raw = fs.readFileSync(tokenPath, "utf8").trim();
    if (!raw) return null;

    let outer: any;
    try {
      outer = JSON.parse(raw);
    } catch {
      outer = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    }
    if (!outer || typeof outer !== "object") return null;

    let tok = outer.token ?? outer;
    if (typeof tok === "string") {
      tok = JSON.parse(tok);
    }
    if (!tok || typeof tok !== "object") return null;

    const accessToken =
      typeof tok.access_token === "string" && tok.access_token.trim()
        ? tok.access_token.trim()
        : undefined;
    const refreshToken =
      typeof tok.refresh_token === "string" && tok.refresh_token.trim()
        ? tok.refresh_token.trim()
        : undefined;
    let expiresAtMs: number | undefined;
    if (typeof tok.expiry === "string" && tok.expiry.trim()) {
      const parsed = Date.parse(tok.expiry);
      if (Number.isFinite(parsed) && parsed > 0) expiresAtMs = parsed;
    }

    if (!accessToken && !refreshToken) return null;
    return { accessToken, refreshToken, expiresAtMs };
  } catch {
    return null;
  }
}

export interface AccountStorageGcOptions {
  now?: number;
  /** Default: 48 hours. */
  maxAgeMs?: number;
  /** Active or parked native ACP session IDs that must never be pruned. */
  protectedSessionIds?: ReadonlySet<string>;
  /** Default: 32 MiB of retained `log/*.log` output per account. */
  maxLogDirBytes?: number;
}

const DEFAULT_STORAGE_GC_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const DEFAULT_LOG_DIR_MAX_BYTES = 32 * 1024 * 1024;
/** A surviving `cli.log` is tail-truncated to at least this much context. */
const MIN_CLI_LOG_TAIL_BYTES = 1024 * 1024;
/** A session this fresh may legitimately have no `conversations/<id>.db` yet. */
const SUMMARY_ORPHAN_GRACE_MS = 5 * 60 * 1000;

interface SummaryDbHandle {
  all: (sql: string, ...params: any[]) => any[];
  run: (sql: string, ...params: any[]) => void;
  exec: (sql: string) => void;
  close: () => void;
}

/**
 * Opens `conversation_summaries.db` read-write *without* creating it, so a
 * gateway that never ran the CLI cannot materialize a stray empty database.
 * Returns null when SQLite is unavailable or the file cannot be opened.
 */
function openSummaryDbReadWrite(file: string): SummaryDbHandle | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database, constants } = require("bun:sqlite");
    if (typeof Database === "function") {
      const flags =
        (constants?.SQLITE_OPEN_READWRITE ?? 2) |
        (constants?.SQLITE_OPEN_URI ?? 0x40);
      const db = new Database(file, flags);
      return {
        all: (sql: string, ...params: any[]) => db.prepare(sql).all(...params),
        run: (sql: string, ...params: any[]) => {
          db.prepare(sql).run(...params);
        },
        exec: (sql: string) => {
          db.run(sql);
        },
        close: () => {
          try {
            db.close();
          } catch {}
        },
      };
    }
  } catch {}

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      const db = new DatabaseSync(file, { readOnly: false, timeout: 0 });
      return {
        all: (sql: string, ...params: any[]) => db.prepare(sql).all(...params),
        run: (sql: string, ...params: any[]) => {
          db.prepare(sql).run(...params);
        },
        exec: (sql: string) => {
          db.exec(sql);
        },
        close: () => {
          try {
            db.close();
          } catch {}
        },
      };
    }
  } catch {}

  return null;
}

/**
 * True only when `conversations/<sessionId>.db` is definitively missing.
 *
 * Every other outcome (the file still exists, or the filesystem refused to say)
 * is treated as "maybe present", so an index row is preserved rather than
 * dropped for a session whose transcript is still there.
 */
function isTranscriptAbsent(cliDir: string, sessionId: string): boolean {
  try {
    fs.lstatSync(path.join(cliDir, "conversations", `${sessionId}.db`));
    return false;
  } catch (err: any) {
    return err?.code === "ENOENT";
  }
}

/**
 * Drops summary / full-text-index / parent rows whose `conversations/<id>.db`
 * no longer exists, and compacts the FTS5 index afterwards.
 *
 * `agy 1.5.8` keeps `conversation_summaries.db` (with `conversations_fts` and
 * `conversation_parents`) separate from `conversations/*.db`, so deleting an old
 * transcript leaves its index rows behind. Everything here is best-effort: a
 * locked or unexpected schema is skipped silently instead of failing the sweep.
 */
function reclaimConversationSummaryOrphans(
  cliDir: string,
  keepIds: ReadonlySet<string>,
  now: number,
  maxAgeMs: number,
): number {
  const summaryDbPath = path.join(cliDir, "conversation_summaries.db");
  if (!fs.existsSync(summaryDbPath)) return 0;

  const db = openSummaryDbReadWrite(summaryDbPath);
  if (!db) return 0;

  try {
    try {
      db.exec("PRAGMA busy_timeout = 50");
    } catch {}

    const tables = new Set<string>();
    for (const row of db.all(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
    )) {
      const name = typeof row?.name === "string" ? row.name : "";
      if (name) tables.add(name);
    }
    if (tables.size === 0) return 0;

    const recentGraceMs = Math.min(maxAgeMs, SUMMARY_ORPHAN_GRACE_MS);
    const recentIds = new Set<string>();
    const orphanIds = new Set<string>();
    const noteId = (raw: unknown): string => {
      if (typeof raw !== "string") return "";
      const id = raw.trim();
      return id && !keepIds.has(id) ? id : "";
    };

    if (tables.has("conversation_summaries")) {
      const rows = db.all(
        "SELECT conversation_id, last_modified_time FROM conversation_summaries",
      );
      for (const row of rows) {
        const id = noteId(row?.conversation_id);
        if (!id) continue;
        const raw = row?.last_modified_time;
        const parsed =
          typeof raw === "number"
            ? raw < 1e12
              ? raw * 1000
              : raw
            : typeof raw === "string"
              ? Date.parse(raw)
              : Number.NaN;
        if (Number.isFinite(parsed) && now - parsed <= recentGraceMs) {
          recentIds.add(id);
        }
      }
      for (const row of rows) {
        const id = noteId(row?.conversation_id);
        if (id && !recentIds.has(id)) orphanIds.add(id);
      }
    }

    if (tables.has("conversations_fts")) {
      for (const row of db.all(
        "SELECT DISTINCT conversation_id FROM conversations_fts",
      )) {
        const id = noteId(row?.conversation_id);
        if (id && !recentIds.has(id)) orphanIds.add(id);
      }
    }

    if (tables.has("conversation_parents")) {
      for (const row of db.all(
        "SELECT conversation_id, parent_id FROM conversation_parents",
      )) {
        for (const raw of [row?.conversation_id, row?.parent_id]) {
          const id = noteId(raw);
          if (id && !recentIds.has(id)) orphanIds.add(id);
        }
      }
    }

    if (orphanIds.size === 0) return 0;

    // A session is only an orphan when its transcript is provably gone. This
    // keeps a failed unlink, an unreadable directory, or a concurrent create
    // from costing a live conversation its summary, FTS entries and parent link.
    for (const id of Array.from(orphanIds)) {
      if (!isTranscriptAbsent(cliDir, id)) orphanIds.delete(id);
    }
    if (orphanIds.size === 0) return 0;

    let deleted = 0;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch {
      return 0;
    }
    try {
      for (const id of orphanIds) {
        if (tables.has("conversations_fts")) {
          db.run("DELETE FROM conversations_fts WHERE conversation_id = ?", id);
        }
        if (tables.has("conversation_parents")) {
          db.run(
            "DELETE FROM conversation_parents WHERE conversation_id = ? OR parent_id = ?",
            id,
            id,
          );
        }
        if (tables.has("conversation_summaries")) {
          db.run("DELETE FROM conversation_summaries WHERE conversation_id = ?", id);
        }
        deleted++;
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return 0;
    }

    try {
      if (tables.has("conversations_fts")) {
        db.run("INSERT INTO conversations_fts(conversations_fts) VALUES('optimize')");
      }
    } catch {}
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {}

    return deleted;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Prunes expired artifacts inside isolated account directories
 * (`$AGY_ACP_DATA_DIR/accounts/*`) so long-running gateways do not accumulate
 * unbounded SQLite / tool-output / log files:
 *
 * 1. `conversations/*.db` (+ `-wal` / `-shm`)
 * 2. `brain/<sessionId>/`
 * 3. `log/*.log` older than `maxAgeMs`, then capped to `maxLogDirBytes`
 * 4. `annotations/<sessionId>.pbtxt` and `implicit/<sessionId>.pb`
 * 5. `crashes/*`
 * 6. `cli.log` (emptied when stale, tail-truncated when oversized)
 * 7. orphaned `conversation_summaries.db` rows + FTS5 index entries
 */
export function sweepStaleAccountStorage(
  options: AccountStorageGcOptions = {},
): number {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STORAGE_GC_MAX_AGE_MS;
  const maxLogDirBytes = options.maxLogDirBytes ?? DEFAULT_LOG_DIR_MAX_BYTES;
  const protectedIds = options.protectedSessionIds ?? new Set<string>();
  let removed = 0;

  let accountsRoot: string;
  try {
    accountsRoot = path.join(getPluginDataRoot(), "accounts");
    if (!fs.existsSync(accountsRoot)) return 0;
  } catch {
    return 0;
  }

  let accountDirs: fs.Dirent[];
  try {
    accountDirs = fs.readdirSync(accountsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const acctEnt of accountDirs) {
    if (!acctEnt.isDirectory() || !UUID_REGEX.test(acctEnt.name)) continue;
    const cliDir = path.join(
      accountsRoot,
      acctEnt.name,
      ".gemini",
      "antigravity-cli",
    );

    // Session IDs that still have a transcript on disk, plus whatever the
    // caller marked active: nothing below may drop artifacts for these.
    const keepIds = new Set<string>(protectedIds);

    // 1. Prune conversations/<sessionId>.db (+ -wal / -shm sidecars)
    const convDir = path.join(cliDir, "conversations");
    try {
      if (fs.existsSync(convDir)) {
        const entries = fs.readdirSync(convDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile() || !ent.name.endsWith(".db")) continue;
          const sessionId = ent.name.slice(0, -3);
          if (!sessionId) continue;
          if (protectedIds.has(sessionId)) {
            keepIds.add(sessionId);
            continue;
          }
          // Per-entry isolation: one unreadable database must not abort the scan
          // that decides which summaries are still referenced.
          try {
            const dbFile = path.join(convDir, ent.name);
            const walFile = `${dbFile}-wal`;
            const shmFile = `${dbFile}-shm`;
            let newestMtime = fs.statSync(dbFile).mtimeMs;
            try {
              if (fs.existsSync(walFile)) {
                newestMtime = Math.max(newestMtime, fs.statSync(walFile).mtimeMs);
              }
            } catch {}
            if (now - newestMtime > maxAgeMs) {
              for (const f of [walFile, shmFile, dbFile]) {
                try {
                  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
                } catch {}
              }
              removed++;
            }
            // Keep unless the transcript is really gone: a failed delete must
            // not be read as "orphaned" by the summary sweep below.
            if (fs.existsSync(dbFile)) keepIds.add(sessionId);
          } catch {
            keepIds.add(sessionId);
          }
        }
      }
    } catch {}

    // 2. Prune brain/<sessionId> directories (offloaded tool outputs / scratch)
    const newestTreeMtimeMs = (dir: string, depth = 0): number => {
      let newest = fs.lstatSync(dir).mtimeMs;
      if (depth >= 6) return newest;
      const children = fs.readdirSync(dir, { withFileTypes: true });
      for (const child of children) {
        const childPath = path.join(dir, child.name);
        const childStat = fs.lstatSync(childPath);
        if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
        if (child.isDirectory() && !child.isSymbolicLink()) {
          const subNewest = newestTreeMtimeMs(childPath, depth + 1);
          if (subNewest > newest) newest = subNewest;
        }
      }
      return newest;
    };

    const brainDir = path.join(cliDir, "brain");
    try {
      if (fs.existsSync(brainDir)) {
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory() || protectedIds.has(ent.name)) continue;
          const target = path.join(brainDir, ent.name);
          try {
            const newestMtime = newestTreeMtimeMs(target);
            if (now - newestMtime > maxAgeMs) {
              fs.rmSync(target, { recursive: true, force: true });
              removed++;
            }
          } catch {}
        }
      }
    } catch {}

    // 3. Prune log/cli-*.log by age, then cap the retained byte budget
    const logDir = path.join(cliDir, "log");
    try {
      if (fs.existsSync(logDir)) {
        const entries = fs.readdirSync(logDir, { withFileTypes: true });
        const retainedLogs: Array<{
          filePath: string;
          size: number;
          mtimeMs: number;
        }> = [];
        let retainedBytes = 0;
        for (const ent of entries) {
          if (!ent.isFile() || !ent.name.endsWith(".log")) continue;
          const target = path.join(logDir, ent.name);
          const st = fs.statSync(target);
          if (now - st.mtimeMs > maxAgeMs) {
            fs.rmSync(target, { force: true });
            removed++;
            continue;
          }
          retainedLogs.push({
            filePath: target,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
          retainedBytes += st.size;
        }
        if (retainedBytes > maxLogDirBytes) {
          retainedLogs.sort((a, b) => a.mtimeMs - b.mtimeMs);
          for (const log of retainedLogs) {
            if (retainedBytes <= maxLogDirBytes) break;
            try {
              fs.rmSync(log.filePath, { force: true });
              retainedBytes -= log.size;
              removed++;
            } catch {}
          }
        }
      }
    } catch {}

    // 4. Prune annotations/<sessionId>.pbtxt and implicit/<sessionId>.pb
    for (const sub of ["annotations", "implicit"]) {
      const dir = path.join(cliDir, sub);
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const stem = path.parse(ent.name).name;
          if (protectedIds.has(stem) || protectedIds.has(ent.name)) continue;
          if (keepIds.has(stem)) continue;
          const target = path.join(dir, ent.name);
          const st = fs.statSync(target);
          if (now - st.mtimeMs > maxAgeMs) {
            fs.rmSync(target, { force: true });
            removed++;
          }
        }
      } catch {}
    }

    // 5. Prune crashes/* (names embed one or more session/process IDs)
    const crashDir = path.join(cliDir, "crashes");
    try {
      if (fs.existsSync(crashDir)) {
        const entries = fs.readdirSync(crashDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          let referenced = false;
          for (const id of protectedIds) {
            if (id && ent.name.includes(id)) {
              referenced = true;
              break;
            }
          }
          if (referenced) continue;
          const target = path.join(crashDir, ent.name);
          const st = fs.statSync(target);
          if (now - st.mtimeMs > maxAgeMs) {
            fs.rmSync(target, { force: true });
            removed++;
          }
        }
      }
    } catch {}

    // 6. Empty (stale) or tail-truncate (oversized) the root cli.log, always
    // in place so an open appender never loses the file.
    const cliLogPath = path.join(cliDir, "cli.log");
    let cliLogFd: number | undefined;
    try {
      cliLogFd = fs.openSync(cliLogPath, "r+");
      const st = fs.fstatSync(cliLogFd);
      if (st.isFile()) {
        if (now - st.mtimeMs > maxAgeMs) {
          // Truncate in place rather than unlinking. An idle CLI process can hold
          // this file open with O_APPEND for hours; unlinking would leave it
          // writing to an unreachable inode. Emptying the file (and skipping the
          // count when it is already empty) keeps repeated sweeps idempotent.
          if (st.size > 0) {
            fs.ftruncateSync(cliLogFd, 0);
            removed++;
          }
        } else if (st.size > maxLogDirBytes && now - st.mtimeMs > 60_000) {
          // Truncate in place. Writing a fresh file and renaming it over
          // `cli.log` would strand a live process's open O_APPEND descriptor on
          // the unlinked inode: every later log line would vanish from the
          // visible log (and stay unreclaimable) until that process exited.
          const keepBytes = Math.min(maxLogDirBytes, MIN_CLI_LOG_TAIL_BYTES);
          const length = Math.min(keepBytes, st.size);
          const tail = Buffer.alloc(length);
          fs.readSync(cliLogFd, tail, 0, length, st.size - length);
          fs.ftruncateSync(cliLogFd, 0);
          fs.writeSync(cliLogFd, tail, 0, length, 0);
          removed++;
        }
      }
    } catch {
      // A missing or unreadable cli.log is not an error for the sweep.
    } finally {
      if (cliLogFd !== undefined) {
        try {
          fs.closeSync(cliLogFd);
        } catch {}
      }
    }

    // 7. Reclaim orphaned summary rows and FTS5 index entries
    removed += reclaimConversationSummaryOrphans(cliDir, keepIds, now, maxAgeMs);
  }

  return removed;
}
