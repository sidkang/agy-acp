import { BridgeHttpError } from "./types";
import { createAuthMethods, resolveAccountDescriptor } from "./accounts/auth";
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
  PROVIDER_ID,
  PROVIDER_OPTION_SCHEMAS,
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

async function AntigravityMagpiePlugin(
  input?: MagpiePluginInput,
  pkgOptions?: Record<string, unknown>,
) {
  const scheduler = new GlobalScheduler();
  const mcpServer = getSharedMcpServer();
  const catalogService = new CatalogService();
  const coordinator = new SessionCoordinator({
    scheduler,
    mcpServer,
  });

  const currentSlotKey = (): string => {
    const k = input?.magpie?.account?.(PROVIDER_ID);
    return typeof k === "string" && k.trim() ? k.trim() : PROVIDER_ID;
  };

  return {
    config: async (cfg: Record<string, any>) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] = {
        ...(cfg.provider[PROVIDER_ID] ?? {}),
        name: "Antigravity ACP",
        npm: "@ai-sdk/anthropic",
        api: "agy://local",
      };
    },

    auth: {
      provider: PROVIDER_ID,
      single: false,
      maxConcurrency: 16,
      maxAccounts: 0,
      options: PROVIDER_OPTION_SCHEMAS,
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
              const rawBody = await readRequestBody(fetchInput, init);
              const signal = init.signal ?? undefined;

              const req = parseAnthropicRequest(
                rawBody,
                headers,
                providerOptions,
              );

              const modelSelection = await catalogService.resolveModel(
                account,
                req.model,
                req.effortOverride,
              );
              if (!modelSelection) {
                throw new BridgeHttpError(
                  400,
                  "invalid_request_error",
                  `Unknown or unavailable Antigravity model: '${req.model}'`,
                );
              }

              const events = coordinator.executeTurn(
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
                );
              }
              return await collectAnthropicJsonResponse(
                req.model,
                events,
                signal,
              );
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
            includeRawIds: true,
          });
        }
        const slotKey = currentSlotKey();
        const account = resolveAccountDescriptor(slotKey, ctx.auth);
        const catalog = await catalogService.getCatalog(account, {
          signal: ctx.signal,
        });
        return buildProviderModels(catalog, { includeRawIds: true });
      },
    },

    "chat.headers": async (
      hookInput: { sessionID?: string } | undefined,
      output: { headers: Record<string, string> },
    ) => {
      if (hookInput?.sessionID && hookInput.sessionID.trim()) {
        output.headers[SESSION_ID_HEADER] = hookInput.sessionID.trim();
      }
    },
  };
}

export default {
  id: PROVIDER_ID,
  server: AntigravityMagpiePlugin,
};
