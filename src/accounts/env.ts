import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDescriptor } from "../types";

// Capture host startup environment ONCE at module load
export const HOST_HOME = process.env.HOME;
export const HOST_XDG_DATA_HOME = process.env.XDG_DATA_HOME;
export const HOST_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
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

  // Delete cross-contaminating vars
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.ANTIGRAVITY_APP_DATA_DIR;
  delete env.ANTIGRAVITY_CONFIG_REL_DIR;

  // Browser suppression & auto-update
  env.PATH = `${shimDir}${path.delimiter}${env.PATH ?? HOST_PATH}`;
  env.BROWSER = "/usr/bin/false";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? "true";

  const finalArgs = [...args];
  let cwd: string;

  if (account.mode === "isolated") {
    const home = account.isolatedHomeDir ?? resolveIsolatedHomeDir(account.accountRef);
    env.HOME = home;
    // SSH_CONNECTION triggers agy's file-based token storage, bypassing Keychain / SecretService
    env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 22";
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    env.XDG_STATE_HOME = path.join(home, ".local", "state");

    if (finalArgs[0] === "acp") {
      const geminiDir = path.join(home, ".gemini");
      const appDataDir = path.join(geminiDir, "antigravity-cli");
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
  return spawn(bin, finalArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

/**
 * Kills a child process and its process tree cleanly.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child || !child.pid) return;
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
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
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

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgy(account, args, { cwd: options?.cwd, extraEnv: options?.extraEnv });
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
  return out;
}
