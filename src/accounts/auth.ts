import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountDescriptor, PersistedAuthMetadata } from "../types";
import {
  execAgyBounded,
  killProcessTree,
  redactSecrets,
  resolveIsolatedHomeDir,
  spawnAgy,
} from "./env";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves an AccountDescriptor from slot key and raw auth metadata.
 * If mode is isolated (or key starts with "agy-isolated:"), validates UUID and resolves isolated home dir.
 * Otherwise defaults to host mode.
 */
export function resolveAccountDescriptor(slotKey: string, rawAuth: unknown): AccountDescriptor {
  if (typeof rawAuth === "object" && rawAuth !== null) {
    const raw = rawAuth as Record<string, unknown>;
    const metadata = raw["metadata"] as PersistedAuthMetadata | undefined;
    const key = typeof raw["key"] === "string" ? raw["key"] : undefined;

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
      const label =
        (typeof metadata?.email === "string" && metadata.email) ||
        (typeof metadata?.label === "string" && metadata.label) ||
        slotKey;
      return {
        slotKey,
        accountRef,
        mode: "isolated",
        label,
        isolatedHomeDir: resolveIsolatedHomeDir(accountRef),
      };
    }

    const label =
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

export interface AuthMethodSuccess {
  type: "success";
  key: string;
  metadata: PersistedAuthMetadata;
}

export interface AuthMethodFailed {
  type: "failed";
  error: string;
}

export interface OAuthFlowResult {
  url: string;
  instructions: string;
  method: "code";
  opened: boolean;
  callback: (
    rawCode: string,
    callbackOpts?: { signal?: AbortSignal }
  ) => Promise<AuthMethodSuccess | AuthMethodFailed>;
}

/**
 * Creates auth methods for Magpie plugin registration:
 * 1. OAuth method for isolated Google accounts.
 * 2. API method adopting existing local host agy sign-in.
 */
export function createAuthMethods() {
  return [
    {
      type: "oauth" as const,
      label: "Sign in isolated Google account (multi-account)",
      prompts: [
        {
          type: "text" as const,
          key: "label",
          message: "Account label or email (optional, for display)",
          placeholder: "work@example.com",
        },
      ],
      authorize: async (
        inputs?: Record<string, string>,
        options?: { signal?: AbortSignal }
      ): Promise<OAuthFlowResult | AuthMethodFailed> => {
        const accountRef = crypto.randomUUID();
        const isolatedHomeDir = resolveIsolatedHomeDir(accountRef);
        const cleanLabel = inputs?.["label"]?.trim() || "";
        const isolatedAccount: AccountDescriptor = {
          slotKey: `agy-isolated:${accountRef}`,
          accountRef,
          mode: "isolated",
          label: cleanLabel || `agy-${accountRef.slice(0, 8)}`,
          isolatedHomeDir,
        };

        let child: ReturnType<typeof spawnAgy>;
        try {
          child = spawnAgy(isolatedAccount, ["acp", "--login"]);
        } catch (err: any) {
          try {
            fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
          } catch {}
          return {
            type: "failed",
            error: `Failed to spawn agy acp --login: ${err?.message ?? String(err)}`,
          };
        }

        let out = "";
        let settled = false;
        let startTimer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (startTimer) clearTimeout(startTimer);
        };

        const authUrlPromise = new Promise<{ url: string }>((resolve, reject) => {
          startTimer = setTimeout(() => {
            killProcessTree(child);
            try {
              fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
            } catch {}
            reject(new Error("Timeout waiting for agy to output sign-in URL"));
          }, 30_000);

          const onAbort = () => {
            killProcessTree(child);
            try {
              fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
            } catch {}
            reject(new Error("Sign-in aborted"));
          };

          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          options?.signal?.addEventListener("abort", onAbort, { once: true });

          const onData = (chunk: Buffer) => {
            out += chunk.toString("utf8");
            const match =
              /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/.exec(out) ||
              /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(out);
            if (match && !settled) {
              settled = true;
              cleanup();
              options?.signal?.removeEventListener("abort", onAbort);
              resolve({ url: match[0] });
            }
          };

          child.stdout.on("data", onData);
          child.stderr.on("data", onData);

          child.on("error", (err) => {
            if (!settled) {
              settled = true;
              cleanup();
              killProcessTree(child);
              try {
                fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
              } catch {}
              reject(err);
            }
          });

          child.on("exit", (code) => {
            if (!settled) {
              settled = true;
              cleanup();
              killProcessTree(child);
              try {
                fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
              } catch {}
              reject(
                new Error(
                  `agy exited with code ${code} before printing sign-in URL. Output: ${redactSecrets(
                    out.trim()
                  )}`
                )
              );
            }
          });
        });

        try {
          const { url } = await authUrlPromise;
          let used = false;

          const singleUseCallback = async (
            rawCode: string,
            callbackOpts?: { signal?: AbortSignal }
          ): Promise<AuthMethodSuccess | AuthMethodFailed> => {
            if (used) {
              throw new Error("Callback has already been invoked");
            }
            used = true;

            let code: string;
            try {
              code = extractAuthorizationCode(rawCode);
            } catch (err: any) {
              killProcessTree(child);
              try {
                fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
              } catch {}
              return { type: "failed", error: err?.message ?? String(err) };
            }

            const waitExit = new Promise<number | null>((resolve, reject) => {
              const timer = setTimeout(() => {
                killProcessTree(child);
                reject(new Error("Timed out waiting for agy to complete sign-in"));
              }, 60_000);

              const onCbAbort = () => {
                clearTimeout(timer);
                killProcessTree(child);
                reject(new Error("Callback aborted"));
              };

              if (callbackOpts?.signal?.aborted) {
                onCbAbort();
                return;
              }
              callbackOpts?.signal?.addEventListener("abort", onCbAbort, { once: true });

              child.on("exit", (exitCode) => {
                clearTimeout(timer);
                callbackOpts?.signal?.removeEventListener("abort", onCbAbort);
                resolve(exitCode);
              });
            });

            try {
              child.stdin.write(code + "\n");
              child.stdin.end();
              await waitExit;
            } catch (err: any) {
              killProcessTree(child);
              try {
                fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
              } catch {}
              return { type: "failed", error: `Login failed: ${err?.message ?? String(err)}` };
            }

            // Verify authentication actually works in this isolated home dir
            try {
              const probe = await execAgyBounded(isolatedAccount, ["models"], {
                timeoutMs: 20_000,
                signal: callbackOpts?.signal,
              });

              if (
                probe.exitCode !== 0 ||
                !probe.stdout.trim() ||
                /please sign in|not (?:logged|signed) in|login required/i.test(
                  probe.stdout + probe.stderr
                )
              ) {
                throw new Error(
                  `agy models verification failed: exitCode=${probe.exitCode}, output=${redactSecrets(
                    (probe.stdout + " " + probe.stderr).trim()
                  )}`
                );
              }

              // Verify persisted auth state in <isolatedHomeDir>/.gemini
              const geminiDir = path.join(isolatedHomeDir, ".gemini");
              if (!fs.existsSync(geminiDir)) {
                throw new Error("No .gemini directory created in isolated home dir");
              }

              const metadata: PersistedAuthMetadata = {
                schemaVersion: 1,
                accountRef,
                mode: "isolated",
                email: cleanLabel || `agy-${accountRef.slice(0, 8)}`,
                label: cleanLabel || undefined,
              };

              return {
                type: "success",
                key: `agy-isolated:${accountRef}`,
                metadata,
              };
            } catch (err: any) {
              killProcessTree(child);
              try {
                fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
              } catch {}
              return {
                type: "failed",
                error: `Verification failed: ${err?.message ?? String(err)}`,
              };
            }
          };

          return {
            url,
            instructions: "Sign in with Google, then paste the authorization code or callback URL.",
            method: "code",
            opened: false,
            callback: singleUseCallback,
          };
        } catch (err: any) {
          killProcessTree(child);
          try {
            fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
          } catch {}
          return { type: "failed", error: err?.message ?? String(err) };
        }
      },
    },
    {
      type: "api" as const,
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

        if (
          res.exitCode !== 0 ||
          /please sign in|not (?:logged|signed) in|login required/i.test(
            res.stdout + res.stderr
          ) ||
          !res.stdout.trim()
        ) {
          return {
            type: "failed",
            error:
              "Local agy CLI is not signed in. Run 'agy' in a terminal first or use 'Sign in isolated Google account'.",
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
          metadata,
        };
      },
    },
  ];
}
