import { BridgeHttpError } from "./types";
import {
  createAuthMethods,
  IMPORT_FROM_EN,
  IMPORT_FROMS,
  importAccountFiles,
  resolveAccountDescriptor,
} from "./accounts/auth";
import {
  buildProviderModels,
  CatalogService,
  getStaticFallbackCatalog,
} from "./usage/catalog";
import { queryAccountUsage } from "./usage/quota";
import { getSharedMcpServer } from "./mcp/http-server";
import { GlobalScheduler } from "./runtime/scheduler";
import { SessionCoordinator } from "./sessions/coordinator";
import {
  collectAnthropicJsonResponse,
  encodeAnthropicSseResponse,
  jsonErrorResponse,
  parseAnthropicRequest,
  SESSION_ID_HEADER,
} from "./protocol/anthropic";
import {
  buildProviderOptionSchemas,
  PROVIDER_ID,
  readProviderOptions,
} from "./options";

export interface MagpiePluginInput {
  magpie?: {
    option?: (provider: string, key: string) => boolean | undefined;
    options?: (provider: string) => Record<string, boolean> | undefined;
    account?: (provider: string) => string | undefined;
  };
  [key: string]: unknown;
}

async function readRequestBody(
  fetchInput: RequestInfo | URL,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) {
    return new TextDecoder().decode(init.body);
  }
  if (init?.body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(init.body));
  }
  if (typeof Request !== "undefined" && fetchInput instanceof Request) {
    return await fetchInput.text();
  }
  if (init?.body != null) {
    return await new Response(init.body as BodyInit).text();
  }
  return "";
}

function requestUrlOf(fetchInput: RequestInfo | URL): string {
  if (typeof fetchInput === "string") return fetchInput;
  if (fetchInput instanceof URL) return fetchInput.href;
  if (typeof Request !== "undefined" && fetchInput instanceof Request) {
    return fetchInput.url;
  }
  return String(fetchInput);
}

function readHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value && value.trim() ? value.trim() : undefined;
  }
  if (typeof headers === "object") {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === lower && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function subagentOf(hookInput: Record<string, any> | undefined): string | undefined {
  if (!hookInput) return undefined;
  const direct =
    hookInput.subagentID ??
    hookInput.subagentId ??
    hookInput.subagent ??
    hookInput.model?.subagentID ??
    hookInput.model?.subagentId ??
    hookInput.model?.subagent ??
    hookInput.message?.subagentID ??
    hookInput.message?.subagentId ??
    hookInput.message?.subagent;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return (
    readHeaderValue(hookInput.headers, "x-magpie-subagent") ??
    readHeaderValue(hookInput.header, "x-magpie-subagent")
  );
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function AntigravityMagpiePlugin(
  input?: MagpiePluginInput,
  pkgOptions?: Record<string, unknown>,
) {
  const catalogService = new CatalogService();
  let coordinator: SessionCoordinator | null = null;

  const getCoordinator = (): SessionCoordinator => {
    if (!coordinator) {
      const scheduler = new GlobalScheduler({
        maxGlobalWorkers: positiveInt(pkgOptions?.maxGlobalWorkers),
        maxPerAccountWorkers: positiveInt(pkgOptions?.maxPerAccountWorkers),
        idleTimeoutMs:
          positiveInt(pkgOptions?.idleTimeoutMs) ??
          positiveInt(pkgOptions?.idleTtlMs),
        awaitingToolTimeoutMs: positiveInt(pkgOptions?.awaitingToolTimeoutMs),
        installSignalHandlers: true,
      });
      const mcpServer = getSharedMcpServer();
      coordinator = new SessionCoordinator({
        scheduler,
        mcpServer,
      });
    }
    return coordinator;
  };

  const currentSlotKey = (): string => {
    const k = input?.magpie?.account?.(PROVIDER_ID);
    return typeof k === "string" && k.trim() ? k.trim() : PROVIDER_ID;
  };

  return {
    config: async (cfg: Record<string, any>) => {
      cfg.provider ??= {};
      const entry = (cfg.provider[PROVIDER_ID] ??= {});
      entry.name ??= "Antigravity ACP";
      entry.npm ??= "@ai-sdk/anthropic";
      entry.api ??= "agy://local";
      entry.models ??= buildProviderModels(getStaticFallbackCatalog(), {
        includeRawIds: false,
      });
    },

    auth: {
      provider: PROVIDER_ID,
      single: false,
      maxConcurrency: 16,
      maxAccounts: 0,
      options: buildProviderOptionSchemas(pkgOptions),
      importFrom: IMPORT_FROM_EN,
      importFroms: IMPORT_FROMS,
      import: (texts: string[] | string, opts?: { signal?: AbortSignal }) =>
        importAccountFiles(texts, opts),
      methods: createAuthMethods(),

      usage: async (
        getAuth: () => Promise<unknown>,
        _provider?: unknown,
        opts?: { signal?: AbortSignal },
      ) => {
        const slotKey = currentSlotKey();
        const rawAuth = await getAuth();
        const account = resolveAccountDescriptor(slotKey, rawAuth);
        const providerOptions = readProviderOptions(input, pkgOptions);
        const catalog = await catalogService.getCatalog(account, {
          signal: opts?.signal,
        });
        const allModelIds = Object.keys(
          buildProviderModels(catalog, { includeRawIds: true }),
        );
        const res = await queryAccountUsage(account, allModelIds, {
          quotaRouting: providerOptions.quotaRouting,
          signal: opts?.signal,
        });
        return {
          user: account.label,
          ...res,
        };
      },

      loader: async (getAuth: () => Promise<unknown>) => {
        const boundSlotKey = currentSlotKey();
        return {
          baseURL: "agy://local",
          apiKey: "agy",
          fetch: async (
            fetchInput: RequestInfo | URL,
            init: RequestInit = {},
          ): Promise<Response> => {
            try {
              const requestUrl = requestUrlOf(fetchInput);
              const rawBody = await readRequestBody(fetchInput, init);

              // Token counting never needs a real agy session. Answer it
              // locally so Magpie/Claude Code's count_tokens probe is cheap and
              // cannot race a model probe by spawning `agy acp`.
              if (/\/count[_-]tokens(?:$|[/?#])/i.test(requestUrl)) {
                try {
                  JSON.parse(rawBody);
                } catch {
                  throw new BridgeHttpError(
                    400,
                    "invalid_request_error",
                    "Invalid JSON request body",
                  );
                }
                const input_tokens = Math.max(1, Math.ceil(rawBody.length / 4));
                return Response.json({ input_tokens });
              }

              const rawAuth = await getAuth();
              const account = resolveAccountDescriptor(boundSlotKey, rawAuth);
              const providerOptions = readProviderOptions(input, pkgOptions);

              const headers = new Headers(
                init.headers ??
                  (typeof Request !== "undefined" &&
                  fetchInput instanceof Request
                    ? fetchInput.headers
                    : undefined),
              );
              const callerSignal =
                init.signal ??
                (typeof Request !== "undefined" && fetchInput instanceof Request
                  ? fetchInput.signal
                  : undefined);
              const turnAbort = new AbortController();
              const onCallerAbort = () => turnAbort.abort();
              if (callerSignal) {
                if (callerSignal.aborted) {
                  turnAbort.abort();
                } else {
                  callerSignal.addEventListener("abort", onCallerAbort, {
                    once: true,
                  });
                }
              }
              const signal = turnAbort.signal;

              try {
                const req = parseAnthropicRequest(
                  rawBody,
                  headers,
                  providerOptions,
                );

                const modelSelection = await catalogService.resolveModel(
                  account,
                  req.model,
                  req.effortOverride,
                  signal,
                );
                if (!modelSelection) {
                  throw new BridgeHttpError(
                    400,
                    "invalid_request_error",
                    `Unknown or unavailable Antigravity model: '${req.model}'`,
                  );
                }

                const events = getCoordinator().executeTurn(
                  account,
                  req,
                  modelSelection,
                  { providerOptions },
                  signal,
                );

                if (req.stream) {
                  return await encodeAnthropicSseResponse(
                    req.model,
                    events,
                    signal,
                    () => turnAbort.abort(),
                  );
                }
                return await collectAnthropicJsonResponse(
                  req.model,
                  events,
                  signal,
                );
              } finally {
                if (callerSignal && turnAbort.signal.aborted) {
                  callerSignal.removeEventListener("abort", onCallerAbort);
                }
              }
            } catch (err) {
              return jsonErrorResponse(err);
            }
          },
        };
      },
    },

    provider: {
      id: PROVIDER_ID,
      models: async (
        _provider: unknown,
        ctx?: { auth?: unknown; signal?: AbortSignal },
      ) => {
        if (!ctx?.auth) {
          return buildProviderModels(getStaticFallbackCatalog(), {
            includeRawIds: false,
          });
        }
        const slotKey = currentSlotKey();
        const account = resolveAccountDescriptor(slotKey, ctx.auth);
        return await catalogService.getModels(account, {
          signal: ctx.signal,
          includeRawIds: false,
        });
      },
    },

    "chat.headers": async (
      hookInput:
        | {
            sessionID?: string;
            model?: {
              providerID?: string;
              subagentID?: string;
              subagentId?: string;
              subagent?: string;
            };
            provider?: { info?: { id?: string } };
            message?: {
              model?: { providerID?: string };
              subagentID?: string;
              subagentId?: string;
              subagent?: string;
            };
            subagentID?: string;
            subagentId?: string;
            subagent?: string;
            headers?: Headers | Record<string, string>;
            header?: Headers | Record<string, string>;
          }
        | undefined,
      output: { headers: Record<string, string> },
    ) => {
      const pid =
        hookInput?.model?.providerID ??
        hookInput?.message?.model?.providerID ??
        hookInput?.provider?.info?.id;
      if (pid && pid !== PROVIDER_ID) return;

      if (hookInput?.sessionID && hookInput.sessionID.trim()) {
        output.headers[SESSION_ID_HEADER] = hookInput.sessionID.trim();
      }

      // Magpie tells the plugin's fetch which subagent asked (X-Magpie-Subagent).
      // Forward it when the host exposes it through the hook input as well.
      const subagent = subagentOf(hookInput as Record<string, any> | undefined);
      if (subagent) output.headers["x-magpie-subagent"] = subagent;
    },
  };
}

export default {
  id: PROVIDER_ID,
  server: AntigravityMagpiePlugin,
};
