import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AccountDescriptor, PersistedAuthMetadata } from "../types";
import {
  execAgyBounded,
  getPluginDataRoot,
  isPidAlive,
  killProcessTree,
  redactSecrets,
  resolveIsolatedHomeDir,
  spawnAgy,
} from "./env";

const AGY_SIGN_IN_REQUIRED_RE = /please sign in|not (?:logged|signed) in|login required/i;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fixed namespace UUID for deterministic RFC 4122 UUIDv5 derivation per canonical Google email.
const AGY_ACCOUNT_NAMESPACE_BYTES = Buffer.from(
  "8e9a4f62b7c14d3ea5109c2b84e17d39",
  "hex"
);

// Antigravity's official installed-app Google OAuth client (same client ID & scopes
// used by `agy acp --login` and `@magpie-community/opencode-antigravity-auth`).
const GOOGLE_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
];
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

const BROWSER_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const LISTENER_MAX_LIFETIME_MS = BROWSER_SIGN_IN_TIMEOUT_MS + 30_000;
// Overall budget for the terminal (`agy acp --login`) flow, from spawn to a
// decided outcome. It is the only owner that can reap a sign-in the user
// abandoned after being shown the authorization URL.
const TERMINAL_SIGN_IN_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const IMPORT_MAX_ACCOUNTS = 100;
const IMPORT_CONCURRENCY = 4;

export const IMPORT_FROM_EN =
  "Choose an exported Antigravity account JSON file (refresh_token, token object, accounts array, Antigravity Switcher / CLIProxyAPI export, or antigravity-oauth-token), or a text file with one refresh token per line.";

export const IMPORT_FROMS: Record<string, string> = {
  zh: "选择导出的 Antigravity 账号 JSON 文件（支持 refresh_token、token 对象、accounts 数组、Antigravity Switcher / CLIProxyAPI 导出文件或 antigravity-oauth-token），或每行一个 refresh_token 的文本文件。",
  "zh-TW":
    "選擇匯出的 Antigravity 帳號 JSON 檔案（支援 refresh_token、token 物件、accounts 陣列、Antigravity Switcher / CLIProxyAPI 匯出檔或 antigravity-oauth-token），或每行一個 refresh_token 的文字檔。",
};

// Serializes provisioning/verification/rollback per accountRef across both
// in-process async tasks and separate host processes sharing the plugin data dir.
const accountProvisionLocks = new Map<string, Promise<void>>();
const ACCOUNT_FILE_LOCK_STALE_MS = 60_000;

function waitForProvisionTurn(
  task: Promise<unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Sign-in cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for concurrent sign-in lock on this account"));
      }, timeoutMs);
    }
    task.then(() => {
      cleanup();
      resolve();
    }, (err) => {
      cleanup();
      reject(err);
    });
  });
}

async function acquireAccountFileLock(
  accountRef: string,
  timeoutMs: number = ACCOUNT_FILE_LOCK_STALE_MS,
  signal?: AbortSignal
): Promise<() => void> {
  const accountsDir = path.join(getPluginDataRoot(), "accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(accountsDir, `${accountRef}.lock`);
  const lockToken = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + timeoutMs;

  const publishLockAtomically = (): boolean => {
    const staging = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(staging, `${lockToken}\n`, { mode: 0o600 });
    try {
      fs.linkSync(staging, lockPath);
      return true;
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      // Fallback for filesystems without hardlinks (e.g. exotic FUSE/FAT)
      if (err?.code === "EXDEV" || err?.code === "EPERM" || err?.code === "ENOSYS") {
        try {
          const fd = fs.openSync(lockPath, "wx", 0o600);
          try {
            fs.writeSync(fd, `${lockToken}\n`);
          } finally {
            fs.closeSync(fd);
          }
          return true;
        } catch (wxErr: any) {
          if (wxErr?.code === "EEXIST") return false;
          throw wxErr;
        }
      }
      throw err;
    } finally {
      try {
        fs.unlinkSync(staging);
      } catch {}
    }
  };

  while (true) {
    if (signal?.aborted) throw new Error("Sign-in cancelled");
    if (publishLockAtomically()) {
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === lockToken) {
            fs.unlinkSync(lockPath);
          }
        } catch {}
      };
    }

    try {
      const firstRead = fs.readFileSync(lockPath, "utf8").trim();
      const ownerPid = Number(firstRead.split(":")[0]);
      if (firstRead && ownerPid > 1 && !isPidAlive(ownerPid)) {
        // Guard against concurrent dead-lock sweepers: jitter + re-verify identical dead token
        await waitForProvisionTurn(new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 40))), signal);
        const secondRead = fs.readFileSync(lockPath, "utf8").trim();
        if (secondRead === firstRead) {
          fs.unlinkSync(lockPath);
          continue;
        }
      }
    } catch {}

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for concurrent sign-in lock on this account");
    }
    await waitForProvisionTurn(new Promise((r) => setTimeout(r, 15)), signal);
  }
}

async function withAccountProvisionLock<T>(
  accountRef: string,
  fn: () => Promise<T>,
  options?: { fileLockTimeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  const prev = accountProvisionLocks.get(accountRef) ?? Promise.resolve();
  let releaseMem!: () => void;
  const gate = new Promise<void>((r) => {
    releaseMem = r;
  });
  const chained = prev.then(() => gate);
  accountProvisionLocks.set(accountRef, chained);
  const deadline = Date.now() + (options?.fileLockTimeoutMs ?? ACCOUNT_FILE_LOCK_STALE_MS);
  // Acquired inside the guarded scope: a failed/timed-out file lock must still
  // release the in-process gate, otherwise every later provisioning of this
  // accountRef would wait on a lock owner that never runs its `finally`.
  let releaseFile: (() => void) | undefined;
  try {
    await waitForProvisionTurn(prev, options?.signal, Math.max(0, deadline - Date.now()));
    releaseFile = await acquireAccountFileLock(accountRef, Math.max(0, deadline - Date.now()), options?.signal);
    return await fn();
  } finally {
    try {
      releaseFile?.();
    } catch {}
    releaseMem();
    // An aborted waiter must not remove a predecessor that still owns the lock.
    void chained.then(() => {
      if (accountProvisionLocks.get(accountRef) === chained) accountProvisionLocks.delete(accountRef);
    });
  }
}

function getAccountIndexFile(): string {
  return path.join(getPluginDataRoot(), "account-index.json");
}

function readAccountIndex(): Record<string, string> {
  try {
    const raw = fs.readFileSync(getAccountIndexFile(), "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function recordAccountIndexMapping(email: string, accountRef: string): void {
  const key = email.trim().toLowerCase();
  if (!key || !key.includes("@") || !UUID_REGEX.test(accountRef)) return;
  try {
    const idx = readAccountIndex();
    const normalizedRef = accountRef.toLowerCase();
    if (idx[key] === normalizedRef) return;
    idx[key] = normalizedRef;
    const file = getAccountIndexFile();
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

function resolveAccountRefForVerifiedEmail(email: string): string {
  const key = email.trim().toLowerCase();
  const idx = readAccountIndex();
  const existingRef = idx[key];
  if (existingRef && UUID_REGEX.test(existingRef)) {
    const existingDir = path.join(getPluginDataRoot(), "accounts", existingRef.toLowerCase());
    if (fs.existsSync(existingDir)) {
      return existingRef.toLowerCase();
    }
  }
  return accountRefFromEmail(email);
}

/**
 * Derives a deterministic RFC 4122 UUIDv5 from a canonical Google email address.
 * Re-signing-in or re-importing the same email updates its isolated home in place
 * without stranding old `accounts/<uuid>` directories.
 */
export function accountRefFromEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = crypto
    .createHash("sha1")
    .update(AGY_ACCOUNT_NAMESPACE_BYTES)
    .update(normalized, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Resolves an AccountDescriptor from slot key and raw auth metadata.
 * If mode is isolated (or key starts with "agy-isolated:"), validates UUID and resolves isolated home dir.
 * Otherwise defaults to host mode.
 */
export function resolveAccountDescriptor(slotKey: string, rawAuth: unknown): AccountDescriptor {
  if (typeof rawAuth === "object" && rawAuth !== null) {
    const raw = rawAuth as Record<string, unknown>;
    const metadata = raw["metadata"] as PersistedAuthMetadata | undefined;
    const key =
      typeof raw["key"] === "string"
        ? raw["key"]
        : typeof raw["refresh"] === "string"
          ? raw["refresh"]
          : undefined;

    const isIsolated =
      metadata?.mode === "isolated" ||
      (typeof key === "string" && key.startsWith("agy-isolated:"));

    if (isIsolated) {
      let ref = metadata?.accountRef;
      if (!ref && key && key.startsWith("agy-isolated:")) {
        ref = key.slice("agy-isolated:".length);
      }
      if (!ref || !UUID_REGEX.test(ref)) {
        throw new Error(`Invalid isolated account ref: '${ref}'`);
      }
      const accountRef = ref.toLowerCase();
      const accountId = typeof raw["accountId"] === "string" ? raw["accountId"].trim() : "";
      const label =
        accountId ||
        (typeof metadata?.email === "string" && metadata.email) ||
        (typeof metadata?.label === "string" && metadata.label) ||
        slotKey;
      if (label.includes("@")) {
        recordAccountIndexMapping(label, accountRef);
      }
      return {
        slotKey,
        accountRef,
        mode: "isolated",
        label,
        isolatedHomeDir: resolveIsolatedHomeDir(accountRef),
      };
    }

    const accountId = typeof raw["accountId"] === "string" ? raw["accountId"].trim() : "";
    const label =
      accountId ||
      (typeof metadata?.email === "string" && metadata.email) ||
      (typeof metadata?.label === "string" && metadata.label) ||
      "local-agy (host)";
    return {
      slotKey,
      accountRef: "host",
      mode: "host",
      label,
      isolatedHomeDir: null,
    };
  }

  return {
    slotKey,
    accountRef: "host",
    mode: "host",
    label: "local-agy (host)",
    isolatedHomeDir: null,
  };
}

/**
 * Extracts authorization code from raw string input.
 * Handles both plain code strings and full callback redirect URLs
 * (e.g. https://antigravity.google/oauth-callback?code=...&scope=...).
 */
export function extractAuthorizationCode(rawInput: string): string {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) {
    throw new Error("Authorization code cannot be empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get("code");
      if (code && code.trim()) {
        return code.trim();
      }
      throw new Error("No authorization code found in URL");
    } catch (err: any) {
      if (err.message.includes("No authorization code")) throw err;
      throw new Error(`Invalid callback URL: ${err.message}`);
    }
  }

  return trimmed;
}

export interface ImportedTokenCandidate {
  refreshToken: string;
  email?: string;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const ALLOWED_ACCOUNT_TYPES = new Set([
  "antigravity",
  "agy",
  "agy-acp",
  "agy-cli",
  "oauth",
  "google",
  "authorized_user",
]);

function normalizeRefreshField(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("agy-isolated:")) return null;
  // Exports may carry a `refreshToken|projectId` pair; only the token is needed.
  const pipeIdx = trimmed.indexOf("|");
  const refreshToken = (pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed).trim();
  return refreshToken || null;
}

/**
 * Parses exported Antigravity account credentials from JSON or plain-text lines.
 */
export function parseImportedAccounts(rawText: string): ImportedTokenCandidate[] {
  const text = String(rawText ?? "").trim();
  if (!text) return [];

  const looksLikeJson = text.startsWith("{") || text.startsWith("[");
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch (err: any) {
    if (looksLikeJson) {
      throw new Error(
        `Invalid JSON in imported account data: ${redactSecrets(err?.message ?? "syntax error")}`
      );
    }
    isJson = false;
  }

  const found: ImportedTokenCandidate[] = [];
  const seenRefresh = new Set<string>();

  const pushCandidate = (candidate: ImportedTokenCandidate) => {
    const rt = candidate.refreshToken.trim();
    if (!rt || /[\r\n\0]/.test(rt) || seenRefresh.has(rt)) return;
    seenRefresh.add(rt);
    const email = candidate.email?.trim();
    found.push({ refreshToken: rt, ...(email ? { email } : {}) });
  };

  const visitObject = (obj: Record<string, any>, depth = 0) => {
    if (depth > 4) return;
    if (typeof obj.type === "string" && obj.type.trim()) {
      const t = obj.type.trim().toLowerCase();
      if (!ALLOWED_ACCOUNT_TYPES.has(t)) {
        const safeType = redactSecrets(obj.type.trim().slice(0, 40));
        throw new Error(`Unsupported account type '${safeType}' (expected Antigravity OAuth JSON)`);
      }
    }

    const nestedToken = isPlainObject(obj.token) ? obj.token : undefined;
    const rawRt =
      nestedToken?.refresh_token ??
      nestedToken?.refreshToken ??
      obj.refresh_token ??
      obj.refreshToken ??
      obj.refresh;

    const normalized = normalizeRefreshField(rawRt);
    if (normalized) {
      const rawEmail =
        obj.email ??
        obj.accountId ??
        nestedToken?.email ??
        (isPlainObject(obj.metadata) ? obj.metadata.email : undefined);

      pushCandidate({
        refreshToken: normalized,
        ...(typeof rawEmail === "string" && rawEmail.trim() ? { email: rawEmail.trim() } : {}),
      });
      return;
    }

    if (Array.isArray(obj.accounts)) {
      for (const item of obj.accounts) {
        if (isPlainObject(item)) visitObject(item, depth + 1);
      }
      return;
    }

    for (const val of Object.values(obj)) {
      if (isPlainObject(val)) {
        visitObject(val, depth + 1);
      }
    }
  };

  if (isJson) {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isPlainObject(item)) visitObject(item, 0);
      }
    } else if (isPlainObject(parsed)) {
      visitObject(parsed, 0);
    }
    return found;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = normalizeRefreshField(line);
    if (normalized) {
      pushCandidate({ refreshToken: normalized });
    }
  }
  return found;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeHtml(text: string): string {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderCallbackHtml(ok: boolean, detail = ""): string {
  const safeDetail = escapeHtml(detail);
  const body = ok
    ? "Signed in to Antigravity ACP. You can close this tab."
    : `Sign-in failed: ${safeDetail}`;
  return `<!doctype html><meta charset="utf-8"><title>Antigravity ACP</title><body style="font:15px system-ui,sans-serif;padding:3em;text-align:center">${body}</body>`;
}

async function startLoopbackCallbackServer(
  handler: http.RequestListener,
  options?: { maxLifetimeMs?: number; signal?: AbortSignal }
): Promise<{ port: number; close: () => void }> {
  const maxAttempts = 5;
  let v4!: http.Server;
  let v6: http.Server | null = null;
  let port = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    v4 = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      v4.once("error", reject);
      v4.listen(0, "127.0.0.1", () => resolve());
    });
    v4.unref?.();

    const addr = v4.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    // Bind matching port on IPv6 loopback (`localhost` often resolves to `::1` first).
    // Retry on EADDRINUSE so another local process on `[::1]:port` never intercepts callbacks.
    const candidateV6 = http.createServer(handler);
    const v6Err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      candidateV6.once("error", (err: NodeJS.ErrnoException) => resolve(err));
      candidateV6.listen(port, "::1", () => resolve(null));
    });

    if (!v6Err) {
      candidateV6.unref?.();
      v6 = candidateV6;
      break;
    }

    try {
      candidateV6.close();
    } catch {}

    if (v6Err.code === "EADDRINUSE" && attempt + 1 < maxAttempts) {
      try {
        v4.close();
        (v4 as any).closeAllConnections?.();
      } catch {}
      continue;
    }

    if (v6Err.code === "EADDRINUSE") {
      try {
        v4.close();
        (v4 as any).closeAllConnections?.();
      } catch {}
      throw new Error(`Loopback port ${port} was occupied on ::1 across ${maxAttempts} retries`);
    }

    // IPv6 disabled/unavailable on host (EAFNOSUPPORT / EADDRNOTAVAIL): IPv4 alone suffices.
    v6 = null;
    break;
  }

  let closed = false;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  const sig = options?.signal;

  const close = () => {
    if (closed) return;
    closed = true;
    if (lifetimeTimer) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = undefined;
    }
    if (sig) {
      sig.removeEventListener("abort", close);
    }
    for (const srv of [v4, v6]) {
      if (!srv) continue;
      try {
        srv.close();
        (srv as any).closeAllConnections?.();
      } catch {}
    }
  };

  const maxLifetimeMs = options?.maxLifetimeMs ?? LISTENER_MAX_LIFETIME_MS;
  if (maxLifetimeMs > 0) {
    lifetimeTimer = setTimeout(close, maxLifetimeMs);
    (lifetimeTimer as any).unref?.();
  }

  if (sig) {
    if (sig.aborted) {
      close();
    } else {
      sig.addEventListener("abort", close, { once: true });
    }
  }

  return { port, close };
}

/**
 * Writes `agy`'s file-backed OAuth credential (`FileTokenStorage`) atomically
 * with `0600` permissions inside an isolated account home directory.
 */
export function writeIsolatedAgyOAuthToken(
  isolatedHomeDir: string,
  params: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }
): void {
  const appDataDir = path.join(isolatedHomeDir, ".gemini", "antigravity-cli");
  const cacheDir = path.join(appDataDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const expiryIso = new Date(Date.now() + Math.max(60, params.expiresIn) * 1000).toISOString();
  const tokenPayload = JSON.stringify({
    token: {
      access_token: params.accessToken,
      token_type: "Bearer",
      refresh_token: params.refreshToken,
      expiry: expiryIso,
      expires_in: Math.max(60, Math.trunc(params.expiresIn)),
    },
    auth_method: "consumer",
  });

  const tokenFile = path.join(appDataDir, "antigravity-oauth-token");
  const tokenTmp = `${tokenFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tokenTmp, tokenPayload, { mode: 0o600 });
  fs.renameSync(tokenTmp, tokenFile);

  const acpStateFile = path.join(cacheDir, "acp-auth-state.json");
  const acpStateTmp = `${acpStateFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(acpStateTmp, JSON.stringify({ methodId: "oauth-personal" }), {
    mode: 0o600,
  });
  fs.renameSync(acpStateTmp, acpStateFile);
}

export interface AuthMethodSuccess {
  type: "success";
  key: string;
  accountId?: string;
  metadata: PersistedAuthMetadata;
}

export interface AuthMethodFailed {
  type: "failed";
  error: string;
  accountId?: string;
}

export interface OAuthAutoFlowResult {
  url: string;
  instructions: string;
  method: "auto";
  opened?: boolean;
  callback: (
    rawCode?: string,
    callbackOpts?: { signal?: AbortSignal }
  ) => Promise<AuthMethodSuccess | AuthMethodFailed>;
}

export interface OAuthCodeFlowResult {
  url: string;
  instructions: string;
  method: "code";
  opened: boolean;
  callback: (
    rawCode: string,
    callbackOpts?: { signal?: AbortSignal }
  ) => Promise<AuthMethodSuccess | AuthMethodFailed>;
}

export interface AuthRuntimeDeps {
  importConcurrency?: number;
  fetchFn?: typeof fetch;
  verifyAccountFn?: (
    account: AccountDescriptor,
    signal?: AbortSignal
  ) => Promise<{ ok: boolean; error?: string }>;
  listenerMaxLifetimeMs?: number;
  /** Test/embedding override for the per-account `.lock` acquisition deadline. */
  accountFileLockTimeoutMs?: number;
  /** Test/embedding override for the terminal (`agy acp --login`) flow deadline. */
  terminalFlowTimeoutMs?: number;
}

/**
 * Combines a caller's cancellation signal with a hard deadline, and reports
 * which one fired.
 *
 * `dispose()` detaches the timer and the caller's `abort` listener, so a
 * long-lived caller signal never accumulates listeners across sign-in
 * attempts. Call it only after the response body has been consumed.
 */
export function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  callerAborted: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = callerSignal?.aborted === true;
  let disposed = false;

  const abortWith = (kind: "caller" | "timeout") => {
    if (disposed || controller.signal.aborted) return;
    if (kind === "caller") callerAborted = true;
    else timedOut = true;
    controller.abort();
  };

  const onCallerAbort = () => abortWith("caller");
  if (callerAborted) {
    controller.abort();
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => abortWith("timeout"), Math.max(0, timeoutMs));
  (timer as any).unref?.();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  };

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => callerAborted,
    dispose,
  };
}

export type LoginAbandonReason = "aborted" | "timeout" | "disposed";

export interface LoginSessionDisposerOptions {
  callerSignal?: AbortSignal;
  timeoutMs: number;
  /** Rollback hook, run at most once, and never after `complete()`. */
  onCleanup?: (reason: LoginAbandonReason, message: string) => void;
  abortMessage?: string;
  timeoutMessage?: string;
}

export type LoginWaitOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "aborted"; message: string }
  | { kind: "timeout"; message: string };

export interface LoginSessionDisposer {
  /** Aborted when the caller cancels or the overall deadline passes. */
  signal: AbortSignal;
  /** Non-null once the flow was abandoned (never after `complete()`). */
  abandonReason: () => string | null;
  /** Races `promise` against abandonment, telling which one decided. */
  waitOutcome: <T>(promise: Promise<T>) => Promise<LoginWaitOutcome<T>>;
  /** Idempotent teardown that runs `onCleanup` at most once. */
  dispose: (explicitMessage?: string) => void;
  /** Detaches timers/listeners without running the rollback cleanup. */
  complete: () => void;
}

/**
 * One lifecycle owner for an interactive sign-in that spans several steps
 * (`authorize()` handing back a URL, then `callback()` finishing it).
 *
 * Both the browser loopback flow and the terminal `agy acp --login` flow use
 * it, so an abandoned sign-in always kills its child process and rolls back
 * its throwaway account directory exactly once, whether it was abandoned by
 * the caller's abort signal, by the overall deadline, or by an early exit.
 */
export function createLoginSessionDisposer(
  options: LoginSessionDisposerOptions
): LoginSessionDisposer {
  const abortMessage = options.abortMessage ?? "Sign-in cancelled";
  const timeoutMessage = options.timeoutMessage ?? "The sign-in timed out";
  const combined = combineSignals(options.callerSignal, options.timeoutMs);
  let abandoned: string | null = combined.callerAborted()
    ? abortMessage
    : null;
  let finished = false;

  const abandonNow = (): string | null => {
    // The recorded reason outlives the teardown: a caller that asks after the
    // cleanup ran must still learn why the sign-in ended.
    if (abandoned !== null) return abandoned;
    if (finished) return null;
    if (combined.callerAborted()) abandoned = abortMessage;
    else if (combined.timedOut()) abandoned = timeoutMessage;
    return abandoned;
  };

  const settle = (reason: LoginAbandonReason, message: string): void => {
    if (finished) return;
    finished = true;
    if (reason !== "disposed" || abandoned === null) abandoned = message;
    combined.dispose();
    try {
      options.onCleanup?.(reason, message);
    } catch {}
  };

  // The deadline or the caller's signal ends the flow on its own, even while
  // the caller is only waiting for the authorization URL: the same `onCleanup`
  // owner reaps the child process and its directory.
  const onAbort = () => {
    const reason: LoginAbandonReason = combined.callerAborted() ? "aborted" : "timeout";
    settle(reason, reason === "aborted" ? abortMessage : timeoutMessage);
  };
  if (!combined.signal.aborted) {
    combined.signal.addEventListener("abort", onAbort, { once: true });
  } else {
    onAbort();
  }

  return {
    signal: combined.signal,
    abandonReason: () => abandonNow(),
    waitOutcome: async <T>(promise: Promise<T>): Promise<LoginWaitOutcome<T>> => {
      const reason = abandonNow();
      if (reason !== null) {
        return combined.timedOut() ? { kind: "timeout", message: reason } : { kind: "aborted", message: reason };
      }
      let abortResolve: (() => void) | null = null;
      const aborted = new Promise<void>((resolve) => {
        abortResolve = resolve;
      });
      const onWaitAbort = () => abortResolve?.();
      combined.signal.addEventListener("abort", onWaitAbort, { once: true });
      try {
        const winner = await Promise.race([
          promise.then((value) => ({ kind: "value" as const, value })),
          aborted.then(() => ({ kind: "abandoned" as const })),
        ]);
        if (winner.kind === "value") return { kind: "resolved", value: winner.value };
        const message = abandonNow() ?? abortMessage;
        return combined.timedOut()
          ? { kind: "timeout", message }
          : { kind: "aborted", message };
      } finally {
        combined.signal.removeEventListener("abort", onWaitAbort);
      }
    },
    dispose: (explicitMessage?: string) => {
      settle("disposed", explicitMessage ?? abortMessage);
    },
    complete: () => {
      if (finished) return;
      finished = true;
      combined.dispose();
    },
  };
}

function parseJsonSafe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractOAuthHttpError(bodyText: string, status: number): string {
  const parsed = parseJsonSafe(bodyText);
  if (isPlainObject(parsed)) {
    if (typeof parsed.error_description === "string" && parsed.error_description.trim()) {
      return redactSecrets(parsed.error_description.trim());
    }
    if (isPlainObject(parsed.error) && typeof parsed.error.message === "string") {
      return redactSecrets(parsed.error.message.trim());
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return redactSecrets(parsed.error.trim());
    }
  }
  const trimmed = String(bodyText ?? "").trim();
  return redactSecrets(trimmed ? trimmed.slice(0, 300) : `HTTP ${status}`);
}

/**
 * True when an `agy models` probe is not proof of a working sign-in: a non-zero
 * exit, empty stdout, or the CLI asking the user to sign in.
 */
function agyModelsProbeFailed(probe: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  return (
    probe.exitCode !== 0 ||
    !probe.stdout.trim() ||
    AGY_SIGN_IN_REQUIRED_RE.test(`${probe.stdout}\n${probe.stderr}`)
  );
}

async function defaultVerifyIsolatedAccount(
  account: AccountDescriptor,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  const probe = await execAgyBounded(account, ["models"], {
    timeoutMs: 20_000,
    signal,
  });
  const combined = `${probe.stdout}\n${probe.stderr}`.trim();
  if (agyModelsProbeFailed(probe)) {
    if (/aicode_scope_missing|missing.*scope/i.test(combined)) {
      return {
        ok: false,
        error:
          "This token lacks the 'aicode' OAuth scope required by agy CLI; sign in once with 'Sign in with Google (browser)' instead.",
      };
    }
    return {
      ok: false,
      error: `agy models verification failed: exitCode=${probe.exitCode}, output=${redactSecrets(
        combined.slice(0, 400)
      )}`,
    };
  }
  return { ok: true };
}

interface BatchOwnedAccount {
  dir: string;
  stamps: Set<string>;
  resultIndices: Set<number>;
  externallyTouched: boolean;
}

interface ProvisionInternalResult {
  outcome: AuthMethodSuccess | AuthMethodFailed;
  createdNewDir?: { accountRef: string; dir: string; commitStamp: string };
}

async function provisionIsolatedAccountFromTokens(
  tokens: {
    refreshToken: string;
    freshlyMintedAccessToken?: string;
    expiresIn?: number;
    emailHint?: string;
  },
  options?: {
    signal?: AbortSignal;
    batchOwned?: Map<string, BatchOwnedAccount>;
    slotIndex?: number;
  },
  deps?: AuthRuntimeDeps
): Promise<ProvisionInternalResult> {
  const doFetch = deps?.fetchFn ?? fetch;
  const verifyAccount = deps?.verifyAccountFn ?? defaultVerifyIsolatedAccount;
  const hint = tokens.emailHint?.trim() || undefined;

  let accessToken = tokens.freshlyMintedAccessToken ?? "";
  let expiresIn = tokens.expiresIn && tokens.expiresIn > 0 ? tokens.expiresIn : 3600;

  // Always mint a fresh access_token from refresh_token unless the browser PKCE flow
  // just minted the pair moments ago. This validates the refresh_token and avoids
  // fabricating a fresh expiry for stale exported access_tokens.
  if (!accessToken) {
    const combined = combineSignals(options?.signal, 30_000);
    try {
      const tokenRes = await doFetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
        }).toString(),
        signal: combined.signal,
      });
      const tokenText = await tokenRes.text();
      if (!tokenRes.ok) {
        return {
          outcome: {
            type: "failed",
            error: `Google token refresh failed (${tokenRes.status}): ${extractOAuthHttpError(
              tokenText,
              tokenRes.status
            )}`,
            ...(hint ? { accountId: hint } : {}),
          },
        };
      }
      const parsed = parseJsonSafe(tokenText);
      if (!isPlainObject(parsed) || typeof parsed.access_token !== "string" || !parsed.access_token) {
        return {
          outcome: {
            type: "failed",
            error: "Google returned no access_token for this refresh_token",
            ...(hint ? { accountId: hint } : {}),
          },
        };
      }
      accessToken = parsed.access_token;
      if (typeof parsed.expires_in === "number" && parsed.expires_in > 0) {
        expiresIn = Math.trunc(parsed.expires_in);
      }
    } catch (err: any) {
      return {
        outcome: {
          type: "failed",
          error: `Google token exchange failed: ${redactSecrets(err?.message ?? String(err))}`,
          ...(hint ? { accountId: hint } : {}),
        },
      };
    } finally {
      combined.dispose();
    }
  }

  // Require canonical verified identity from Google userinfo so an unverified
  // email field in an imported JSON file can never overwrite another account's slot.
  let verifiedEmail = "";
  const whoCombined = combineSignals(options?.signal, 20_000);
  try {
    const whoRes = await doFetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: whoCombined.signal,
    });
    const whoText = await whoRes.text();
    if (!whoRes.ok) {
      return {
        outcome: {
          type: "failed",
          error: `Google userinfo lookup failed (${whoRes.status}): ${extractOAuthHttpError(
            whoText,
            whoRes.status
          )}`,
          ...(hint ? { accountId: hint } : {}),
        },
      };
    }
    const who = parseJsonSafe(whoText);
    if (isPlainObject(who) && typeof who.email === "string" && who.email.trim()) {
      verifiedEmail = who.email.trim();
    }
  } catch (err: any) {
    return {
      outcome: {
        type: "failed",
        error: `Google userinfo lookup failed: ${redactSecrets(err?.message ?? String(err))}`,
        ...(hint ? { accountId: hint } : {}),
      },
    };
  } finally {
    whoCombined.dispose();
  }

  if (!verifiedEmail) {
    return {
      outcome: {
        type: "failed",
        error: "Google userinfo did not return an account email address",
        ...(hint ? { accountId: hint } : {}),
      },
    };
  }

  const accountRef = resolveAccountRefForVerifiedEmail(verifiedEmail);

  return await withAccountProvisionLock(accountRef, async () => {
    const expectedDir = path.join(getPluginDataRoot(), "accounts", accountRef);
    const dirExistedBefore = fs.existsSync(expectedDir);
    const tokenFile = path.join(
      expectedDir,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token"
    );
    const batchEntry = options?.batchOwned?.get(accountRef);
    if (dirExistedBefore && batchEntry) {
      const diskStamp = path.join(expectedDir, ".commit-stamp");
      const stamp = fs.existsSync(diskStamp) ? fs.readFileSync(diskStamp, "utf8").trim() : "";
      if (!batchEntry.stamps.has(stamp)) batchEntry.externallyTouched = true;
    }
    let previousTokenBytes: Buffer | null = null;
    if (dirExistedBefore && fs.existsSync(tokenFile)) {
      try {
        previousTokenBytes = fs.readFileSync(tokenFile);
      } catch {}
    }

    const isolatedHomeDir = resolveIsolatedHomeDir(accountRef);
    const stampPath = path.join(isolatedHomeDir, ".commit-stamp");

    const rollbackFilesystem = () => {
      if (!dirExistedBefore && !fs.existsSync(stampPath)) {
        try {
          fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
        } catch {}
      } else if (previousTokenBytes !== null) {
        try {
          const tmp = `${tokenFile}.rollback.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
          fs.writeFileSync(tmp, previousTokenBytes, { mode: 0o600 });
          fs.renameSync(tmp, tokenFile);
        } catch {}
      }
    };

    try {
      writeIsolatedAgyOAuthToken(isolatedHomeDir, {
        accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn,
      });

      const descriptor: AccountDescriptor = {
        slotKey: `agy-isolated:${accountRef}`,
        accountRef,
        mode: "isolated",
        label: verifiedEmail,
        isolatedHomeDir,
      };

      const verified = await verifyAccount(descriptor, options?.signal);
      if (!verified.ok || options?.signal?.aborted) {
        rollbackFilesystem();
        return {
          outcome: {
            type: "failed",
            error: options?.signal?.aborted
              ? "Sign-in cancelled"
              : verified.error || "agy verification failed",
            accountId: verifiedEmail,
          },
        };
      }

      const commitStamp = crypto.randomUUID();
      const stampTmp = `${stampPath}.${process.pid}.tmp`;
      fs.writeFileSync(stampTmp, `${commitStamp}\n`, { mode: 0o600 });
      fs.renameSync(stampTmp, stampPath);
      recordAccountIndexMapping(verifiedEmail, accountRef);
      if (options?.batchOwned && options.slotIndex !== undefined) {
        if (!dirExistedBefore) {
          options.batchOwned.set(accountRef, {
            dir: isolatedHomeDir,
            stamps: new Set([commitStamp]),
            resultIndices: new Set([options.slotIndex]),
            externallyTouched: false,
          });
        } else if (batchEntry) {
          batchEntry.stamps.add(commitStamp);
          batchEntry.resultIndices.add(options.slotIndex);
        }
      }

      const metadata: PersistedAuthMetadata = {
        schemaVersion: 1,
        accountRef,
        mode: "isolated",
        email: verifiedEmail,
      };

      return {
        outcome: {
          type: "success",
          key: `agy-isolated:${accountRef}`,
          accountId: verifiedEmail,
          metadata,
        },
        createdNewDir: dirExistedBefore
          ? undefined
          : { accountRef, dir: isolatedHomeDir, commitStamp },
      };
    } catch (err: any) {
      rollbackFilesystem();
      return {
        outcome: {
          type: "failed",
          error: redactSecrets(err?.message ?? String(err)),
          accountId: verifiedEmail,
        },
      };
    }
  }, { fileLockTimeoutMs: deps?.accountFileLockTimeoutMs, signal: options?.signal });
}

/**
 * Imports one or more Antigravity account files (`auth.import` hook for Magpie's
 * "Import from a file instead..." / "Import accounts from a file...").
 */
export async function importAccountFiles(
  texts: string[] | string,
  options?: { signal?: AbortSignal },
  deps?: AuthRuntimeDeps
): Promise<Array<AuthMethodSuccess | AuthMethodFailed>> {
  const fileList = Array.isArray(texts) ? texts : [texts];
  type Outcome = AuthMethodSuccess | AuthMethodFailed;
  const slots: Array<{ candidate?: ImportedTokenCandidate; result?: Outcome }> = [];
  const seenRefresh = new Set<string>();
  const batchOwned = new Map<string, BatchOwnedAccount>();

  for (const raw of fileList) {
    if (slots.length >= IMPORT_MAX_ACCOUNTS) break;
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = parseImportedAccounts(raw);
      if (parsed.length === 0) {
        slots.push({ result: { type: "failed", error: "No refresh_token found in file" } });
      }
      for (const item of parsed) {
        if (slots.length >= IMPORT_MAX_ACCOUNTS) break;
        if (seenRefresh.has(item.refreshToken)) continue;
        seenRefresh.add(item.refreshToken);
        slots.push({ candidate: item });
      }
    } catch (err: any) {
      slots.push({ result: { type: "failed", error: redactSecrets(err?.message ?? String(err)) } });
    }
  }

  const cleanupBatchOnAbort = async () => {
    for (const [accountRef, entry] of batchOwned) {
      let cleanupError: string | undefined;
      let rolledBack = false;
      try {
        // Rollback deliberately does not inherit the cancelled caller signal.
        await withAccountProvisionLock(accountRef, async () => {
          if (!entry.externallyTouched) {
            const stampPath = path.join(entry.dir, ".commit-stamp");
            if (!fs.existsSync(entry.dir)) {
              rolledBack = true;
            } else if (
              fs.existsSync(stampPath) &&
              entry.stamps.has(fs.readFileSync(stampPath, "utf8").trim())
            ) {
              fs.rmSync(entry.dir, { recursive: true, force: true });
              if (fs.existsSync(entry.dir)) {
                throw new Error("Account directory still exists after rollback");
              }
              rolledBack = true;
            }
          }
        }, { fileLockTimeoutMs: 10_000 });
      } catch (err: any) {
        cleanupError = `Sign-in cancellation cleanup failed: ${redactSecrets(err?.message ?? String(err))}`;
      }
      if (cleanupError || rolledBack) {
        for (const index of entry.resultIndices) {
          if (slots[index]?.result?.type === "success") {
            slots[index]!.result = {
              type: "failed",
              error: cleanupError ?? "Sign-in cancelled",
              accountId: accountRef,
            };
          }
        }
      }
    }
  };

  const requested = deps?.importConcurrency ?? IMPORT_CONCURRENCY;
  const concurrency = Number.isInteger(requested) ? Math.min(16, Math.max(1, requested)) : IMPORT_CONCURRENCY;
  let nextIndex = 0;
  const worker = async () => {
    while (!options?.signal?.aborted && nextIndex < slots.length) {
      const slotIndex = nextIndex++;
      const slot = slots[slotIndex]!;
      if (!slot.candidate) continue;
      try {
        const provisioned = await provisionIsolatedAccountFromTokens({
          refreshToken: slot.candidate.refreshToken, emailHint: slot.candidate.email,
        }, { ...options, batchOwned, slotIndex }, deps);
        if (!options?.signal?.aborted || provisioned.outcome.type === "success") {
          slot.result = provisioned.outcome;
        }
      } catch (err: any) {
        if (!options?.signal?.aborted) {
          slot.result = { type: "failed", error: redactSecrets(err?.message ?? String(err)) };
        }
      }
    }
  };
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.allSettled(workers);
  if (options?.signal?.aborted) await cleanupBatchOnAbort();
  return slots.flatMap((slot) => slot.result ? [slot.result] : []);
}

/**
 * Creates auth methods for Magpie & OpenCode plugin registration:
 * 1. Browser Google OAuth with automatic loopback callback + remote Callback URL paste fallback.
 * 2. Direct paste import of a refresh_token or exported JSON account.
 * 3. 1-click adoption of existing local host `agy` login.
 * 4. Terminal code flow via `agy acp --login` (fallback).
 */
export function createAuthMethods(deps?: AuthRuntimeDeps) {
  const doFetch = deps?.fetchFn ?? fetch;

  return [
    {
      type: "oauth" as const,
      label: "Sign in with Google (browser)",
      authorize: async (
        _inputs?: Record<string, string>,
        options?: { signal?: AbortSignal }
      ): Promise<OAuthAutoFlowResult> => {
        if (options?.signal?.aborted) {
          return {
            url: "",
            instructions: "Sign-in aborted",
            method: "auto" as const,
            callback: async () => ({ type: "failed", error: "Sign-in aborted" }),
          };
        }

        const verifier = base64UrlEncode(crypto.randomBytes(32));
        const challenge = base64UrlEncode(
          crypto.createHash("sha256").update(verifier).digest()
        );
        const state = base64UrlEncode(crypto.randomBytes(16));

        let resolveCallback!: (value: { code?: string; err?: string }) => void;
        const callbackPromise = new Promise<{ code?: string; err?: string }>((resolve) => {
          resolveCallback = resolve;
        });

        let listener: { port: number; close: () => void };
        try {
          listener = await startLoopbackCallbackServer(
            (req, res) => {
              let url: URL;
              try {
                url = new URL(req.url ?? "/", "http://localhost");
              } catch {
                res.writeHead(400, { "Cache-Control": "no-store" }).end();
                return;
              }
              if (url.pathname !== "/oauth-callback") {
                res.writeHead(404, { "Cache-Control": "no-store" }).end();
                return;
              }
              const err = url.searchParams.get("error") ?? undefined;
              const code = url.searchParams.get("code") ?? undefined;
              const returnedState = url.searchParams.get("state") ?? "";
              if (returnedState !== state || (!code && !err)) {
                res
                  .writeHead(400, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                  })
                  .end(renderCallbackHtml(false, "state mismatch; start the sign-in again"));
                return;
              }
              res
                .writeHead(200, {
                  "Content-Type": "text/html; charset=utf-8",
                  "Cache-Control": "no-store",
                })
                .end(renderCallbackHtml(!err, err ?? ""));
              resolveCallback({ code, err });
            },
            {
              maxLifetimeMs: deps?.listenerMaxLifetimeMs ?? LISTENER_MAX_LIFETIME_MS,
              signal: options?.signal,
            }
          );
        } catch (err: any) {
          const msg = `Failed to start local OAuth callback listener: ${redactSecrets(
            err?.message ?? String(err)
          )}`;
          return {
            url: "",
            instructions: msg,
            method: "auto" as const,
            callback: async () => ({ type: "failed", error: msg }),
          };
        }

        const redirectUri = `http://localhost:${listener.port}/oauth-callback`;
        const query = new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GOOGLE_SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });

        let used = false;
        return {
          url: `${GOOGLE_AUTH_URL}?${query.toString()}`,
          instructions:
            "Sign in with your Google account in the browser; it comes back here when you're done.",
          method: "auto" as const,
          callback: async (
            _rawCode?: string,
            callbackOpts?: { signal?: AbortSignal }
          ): Promise<AuthMethodSuccess | AuthMethodFailed> => {
            if (used) {
              return { type: "failed", error: "Callback has already been invoked" };
            }
            used = true;

            // One lifecycle owner for this callback: the caller's signal and the
            // overall deadline both end it, and every timer/listener is detached
            // in the `finally` below.
            const flow = createLoginSessionDisposer({
              callerSignal: callbackOpts?.signal ?? options?.signal,
              timeoutMs: BROWSER_SIGN_IN_TIMEOUT_MS,
              abortMessage: "Sign-in cancelled",
              timeoutMessage: "The sign-in timed out",
            });

            try {
              const outcome = await flow.waitOutcome(callbackPromise);

              // Close loopback listener immediately once callback/abort/timeout settles
              listener.close();

              if (outcome.kind !== "resolved") {
                return { type: "failed", error: outcome.message };
              }
              const granted = outcome.value;
              if (granted.err) {
                return {
                  type: "failed",
                  error: `Google OAuth error: ${redactSecrets(granted.err)}`,
                };
              }
              if (!granted.code) {
                return { type: "failed", error: "Google returned no authorization code" };
              }

              const tokenCombined = combineSignals(flow.signal, 30_000);
              let tokenText: string;
              try {
                const tokenRes = await doFetch(GOOGLE_TOKEN_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code: granted.code,
                    redirect_uri: redirectUri,
                    client_id: GOOGLE_CLIENT_ID,
                    client_secret: GOOGLE_CLIENT_SECRET,
                    code_verifier: verifier,
                  }).toString(),
                  signal: tokenCombined.signal,
                });
                tokenText = await tokenRes.text();
                if (!tokenRes.ok) {
                  return {
                    type: "failed",
                    error: `Google token exchange failed (${tokenRes.status}): ${extractOAuthHttpError(
                      tokenText,
                      tokenRes.status
                    )}`,
                  };
                }
              } finally {
                tokenCombined.dispose();
              }

              const tokenJson = parseJsonSafe(tokenText);
              if (
                !isPlainObject(tokenJson) ||
                typeof tokenJson.access_token !== "string" ||
                typeof tokenJson.refresh_token !== "string" ||
                !tokenJson.access_token ||
                !tokenJson.refresh_token
              ) {
                return {
                  type: "failed",
                  error: "Google returned no refresh_token; please retry and approve offline access.",
                };
              }

              const provisioned = await provisionIsolatedAccountFromTokens(
                {
                  refreshToken: tokenJson.refresh_token,
                  freshlyMintedAccessToken: tokenJson.access_token,
                  expiresIn:
                    typeof tokenJson.expires_in === "number" && tokenJson.expires_in > 0
                      ? Math.trunc(tokenJson.expires_in)
                      : 3600,
                },
                { signal: flow.signal },
                deps
              );
              return provisioned.outcome;
            } catch (err: any) {
              return {
                type: "failed",
                error: redactSecrets(err?.message ?? String(err)),
              };
            } finally {
              flow.dispose();
              listener.close();
            }
          },
        };
      },
    },
    {
      type: "oauth" as const,
      label: "Import an account (refresh token or JSON export)",
      prompts: [
        {
          type: "text" as const,
          key: "account",
          message: "A refresh token, or an exported account's JSON",
          placeholder: '{"refresh_token": "1//..."}',
        },
      ],
      authorize: async (
        inputs?: Record<string, string>,
        options?: { signal?: AbortSignal }
      ): Promise<OAuthAutoFlowResult> => {
        let candidates: ImportedTokenCandidate[];
        try {
          candidates = parseImportedAccounts(inputs?.["account"] ?? "");
        } catch (err: any) {
          const msg = redactSecrets(err?.message ?? String(err));
          return {
            url: "",
            instructions: msg,
            method: "auto" as const,
            callback: async () => ({ type: "failed", error: msg }),
          };
        }
        if (candidates.length === 0) {
          const msg = "No refresh_token found in the pasted text";
          return {
            url: "",
            instructions: msg,
            method: "auto" as const,
            callback: async () => ({ type: "failed", error: msg }),
          };
        }
        const first = candidates[0]!;
        return {
          url: "",
          instructions: "Verifying account with Google and agy CLI…",
          method: "auto" as const,
          callback: async (_rawCode?: string, callbackOpts?: { signal?: AbortSignal }) => {
            const provisioned = await provisionIsolatedAccountFromTokens(
              {
                refreshToken: first.refreshToken,
                emailHint: first.email,
              },
              { signal: callbackOpts?.signal ?? options?.signal },
              deps
            );
            return provisioned.outcome;
          },
        };
      },
    },
    {
      type: "api" as const,
      keyless: true,
      label: "Adopt existing local agy login (host default)",
      authorize: async (
        _inputs?: Record<string, string>,
        options?: { signal?: AbortSignal }
      ): Promise<AuthMethodSuccess | AuthMethodFailed> => {
        const hostAccount: AccountDescriptor = {
          slotKey: "agy-acp",
          accountRef: "host",
          mode: "host",
          label: "local-agy (host)",
          isolatedHomeDir: null,
        };

        const res = await execAgyBounded(hostAccount, ["models"], {
          timeoutMs: 15_000,
          signal: options?.signal,
        });

        if (agyModelsProbeFailed(res)) {
          return {
            type: "failed",
            error:
              "Local agy CLI is not signed in. Run 'agy' in a terminal first or use 'Sign in with Google (browser)'.",
          };
        }

        const metadata: PersistedAuthMetadata = {
          schemaVersion: 1,
          accountRef: "host",
          mode: "host",
          email: "local-agy (host)",
        };

        return {
          type: "success",
          key: "agy-host-default",
          accountId: "local-agy (host)",
          metadata,
        };
      },
    },
    {
      type: "oauth" as const,
      label: "Sign in via agy terminal code (agy acp --login)",
      prompts: [
        {
          type: "text" as const,
          key: "label",
          message: "Account label or email (optional, for display)",
          placeholder: "work@example.com",
          required: false,
        },
      ],
      authorize: async (
        inputs?: Record<string, string>,
        options?: { signal?: AbortSignal }
      ): Promise<OAuthCodeFlowResult | AuthMethodFailed> => {
        const accountRef = crypto.randomUUID();
        // Recorded before `resolveIsolatedHomeDir` creates the directories: an
        // abandoned sign-in may only roll back its own throwaway account.
        const createdIsolatedDir = !fs.existsSync(
          path.join(getPluginDataRoot(), "accounts", accountRef)
        );
        const isolatedHomeDir = resolveIsolatedHomeDir(accountRef);
        const cleanLabel = inputs?.["label"]?.trim() || "";
        const isolatedAccount: AccountDescriptor = {
          slotKey: `agy-isolated:${accountRef}`,
          accountRef,
          mode: "isolated",
          label: cleanLabel || `agy-${accountRef.slice(0, 8)}`,
          isolatedHomeDir,
        };

        const makeAuthorizeFailure = (rawError: string): any => {
          const error = redactSecrets(rawError);
          return {
            type: "failed" as const,
            error,
            url: "",
            instructions: error,
            method: "auto" as const,
            callback: async () => ({ type: "failed" as const, error }),
          };
        };

        const rollbackIsolatedDir = () => {
          if (!createdIsolatedDir) return;
          try {
            fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
          } catch {}
        };

        let child: ReturnType<typeof spawnAgy>;
        try {
          child = spawnAgy(isolatedAccount, ["acp", "--login"]);
        } catch (err: any) {
          rollbackIsolatedDir();
          return makeAuthorizeFailure(
            `Failed to spawn agy acp --login: ${err?.message ?? String(err)}`
          );
        }

        let out = "";
        let startupPending = true;
        let pendingStartupReject: ((error: Error) => void) | null = null;
        let startTimer: NodeJS.Timeout | undefined;
        let callbackStarted = false;
        let flowAbandonReason: string | undefined;

        // Single idempotent owner of the whole terminal sign-in: the caller's
        // abort signal, the overall flow deadline, and an `agy` exit before the
        // code was submitted all end it the same way, killing the login process
        // and rolling back the throwaway account directory exactly once
        // (`MED-11`). Declared before the disposer so a signal that is already
        // aborted can settle synchronously against initialised state.
        const flow = createLoginSessionDisposer({
          callerSignal: options?.signal,
          timeoutMs: deps?.terminalFlowTimeoutMs ?? TERMINAL_SIGN_IN_FLOW_TIMEOUT_MS,
          abortMessage: "Sign-in aborted",
          timeoutMessage: "Timed out waiting for the agy terminal sign-in to finish",
          onCleanup: (_reason, message) => {
            flowAbandonReason = message;
            if (startTimer) {
              clearTimeout(startTimer);
              startTimer = undefined;
            }
            killProcessTree(child);
            rollbackIsolatedDir();
            const rejectStartup = pendingStartupReject;
            pendingStartupReject = null;
            startupPending = false;
            rejectStartup?.(new Error(message));
          },
        });

        const cleanupAbandonedFlow = (reason?: string) => flow.dispose(reason);
        // Successful sign-in (or an already-handled failure): stop watching and
        // keep the freshly saved account.
        const releaseFlowWatchdog = () => flow.complete();

        if (flow.signal.aborted) {
          return makeAuthorizeFailure(flow.abandonReason() ?? "Sign-in aborted");
        }

        // Killing `agy` mid-login can EPIPE the stdin pipe; that must surface as a
        // failed sign-in, never as an unhandled stream error in the host process.
        child.stdin.on("error", () => {});

        const authUrlPromise = new Promise<{ url: string }>((resolve, reject) => {
          pendingStartupReject = reject;
          startTimer = setTimeout(
            () => cleanupAbandonedFlow("Timeout waiting for agy to output sign-in URL"),
            30_000
          );
          (startTimer as any).unref?.();

          const onData = (chunk: Buffer) => {
            out += chunk.toString("utf8");
            const match =
              /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/.exec(out) ||
              /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(out);
            if (match && startupPending) {
              startupPending = false;
              pendingStartupReject = null;
              if (startTimer) {
                clearTimeout(startTimer);
                startTimer = undefined;
              }
              // The flow-level watchdog keeps running until `callback` finishes:
              // handing out the URL does not prove the sign-in completed.
              resolve({ url: match[0] });
            }
          };

          child.stdout.on("data", onData);
          child.stderr.on("data", onData);

          child.on("error", (err) => {
            cleanupAbandonedFlow(err?.message ?? String(err));
          });

          child.on("exit", (code) => {
            if (startupPending) {
              cleanupAbandonedFlow(
                `agy exited with code ${code} before printing sign-in URL. Output: ${redactSecrets(
                  out.trim()
                )}`
              );
              return;
            }
            if (!callbackStarted) {
              cleanupAbandonedFlow(
                `agy exited with code ${code} before the authorization code was submitted`
              );
            }
          });
        });

        try {
          const { url } = await authUrlPromise;
          let used = false;

          const runCallback = async (
            rawCode: string,
            callbackOpts?: { signal?: AbortSignal }
          ): Promise<AuthMethodSuccess | AuthMethodFailed> => {
            let code: string;
            try {
              code = extractAuthorizationCode(rawCode);
            } catch (err: any) {
              killProcessTree(child);
              rollbackIsolatedDir();
              return { type: "failed", error: err?.message ?? String(err) };
            }

            const waitExit = new Promise<number | null>((resolve, reject) => {
              // An abandoned flow may already have killed the login process.
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve(child.exitCode);
                return;
              }
              const timer = setTimeout(() => {
                killProcessTree(child);
                reject(new Error("Timed out waiting for agy to complete sign-in"));
              }, 60_000);

              const onCbAbort = () => {
                clearTimeout(timer);
                killProcessTree(child);
                reject(new Error("Callback aborted"));
              };

              // The flow's own signal: it carries the caller's cancellation and
              // the overall sign-in deadline, so a stalled `agy` login can never
              // outlive the flow that owns it.
              const cbSignal = callbackOpts?.signal ?? flow.signal;
              if (cbSignal?.aborted) {
                clearTimeout(timer);
                killProcessTree(child);
                reject(new Error("Callback aborted"));
                return;
              }
              cbSignal?.addEventListener("abort", onCbAbort, { once: true });

              child.on("exit", (exitCode) => {
                clearTimeout(timer);
                cbSignal?.removeEventListener("abort", onCbAbort);
                resolve(exitCode);
              });
            });

            try {
              child.stdin.write(code + "\n");
              child.stdin.end();
              await waitExit;
            } catch (err: any) {
              killProcessTree(child);
              rollbackIsolatedDir();
              return {
                type: "failed",
                error: `Login failed: ${redactSecrets(err?.message ?? String(err))}`,
              };
            }

            try {
              const probe = await execAgyBounded(isolatedAccount, ["models"], {
                timeoutMs: 20_000,
                signal: callbackOpts?.signal ?? flow.signal,
              });

              if (agyModelsProbeFailed(probe)) {
                throw new Error(
                  `agy models verification failed: exitCode=${probe.exitCode}, output=${redactSecrets(
                    (probe.stdout + " " + probe.stderr).trim()
                  )}`
                );
              }

              const loggedInMatch = /Logged in as\s+([^\s.\r\n]+@[^\s.\r\n]+)/i.exec(out);
              const detectedEmail = loggedInMatch?.[1]?.trim();
              // The host cancelled (or the flow timed out) while the login process
              // was finishing: never commit a cancelled sign-in.
              if (flowAbandonReason) {
                killProcessTree(child);
                rollbackIsolatedDir();
                return { type: "failed", error: flowAbandonReason };
              }
              if (detectedEmail) {
                recordAccountIndexMapping(detectedEmail, accountRef);
              }
              const identity =
                cleanLabel || detectedEmail || `agy-${accountRef.slice(0, 8)}`;

              const metadata: PersistedAuthMetadata = {
                schemaVersion: 1,
                accountRef,
                mode: "isolated",
                email: cleanLabel
                  ? `${cleanLabel} (${accountRef.slice(0, 8)})`
                  : identity,
                label: cleanLabel || undefined,
              };

              return {
                type: "success",
                key: `agy-isolated:${accountRef}`,
                accountId: metadata.email,
                metadata,
              };
            } catch (err: any) {
              killProcessTree(child);
              rollbackIsolatedDir();
              return {
                type: "failed",
                error: `Verification failed: ${redactSecrets(err?.message ?? String(err))}`,
              };
            }
          };

          const singleUseCallback = async (
            rawCode: string,
            callbackOpts?: { signal?: AbortSignal }
          ): Promise<AuthMethodSuccess | AuthMethodFailed> => {
            if (used) {
              return { type: "failed", error: "Callback has already been invoked" };
            }
            used = true;
            // The callback now owns the tail of the flow; the watchdog keeps
            // watching the process until the outcome is decided.
            callbackStarted = true;
            try {
              return await runCallback(rawCode, callbackOpts);
            } finally {
              releaseFlowWatchdog();
            }
          };

          return {
            url,
            instructions:
              "Sign in with Google, then paste the authorization code or callback URL.",
            method: "code",
            opened: false,
            callback: singleUseCallback,
          };
        } catch (err: any) {
          // Teardown is idempotent: the watchdog may already have cleaned up.
          cleanupAbandonedFlow(err?.message ?? String(err));
          return makeAuthorizeFailure(err?.message ?? String(err));
        }
      },
    },
  ];
}
