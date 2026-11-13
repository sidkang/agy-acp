import type { ProviderOptionsState } from "./types";

export const PROVIDER_ID = "agy-acp";

export interface MagpieOptionSchema {
  key: string;
  label: string;
  description: string;
  default: boolean;
  placement?: "top";
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  confirm?: string;
  confirms?: Record<string, string>;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}

function initialDefault(
  key: string,
  envName: string,
  pkgOptions: Record<string, unknown> | undefined,
  fallback: boolean,
): boolean {
  if (pkgOptions && typeof pkgOptions[key] === "boolean") {
    return pkgOptions[key] as boolean;
  }
  const fromEnv = envBool(envName);
  if (typeof fromEnv === "boolean") return fromEnv;
  return fallback;
}

export function buildProviderOptionSchemas(
  pkgOptions?: Record<string, unknown>,
): MagpieOptionSchema[] {
  return [
    {
      key: "quota_routing",
      label: "Quota-aware multi-account routing",
      description:
        "Gate exhausted 5-hour/weekly model buckets so Magpie routes new turns to other signed-in accounts.",
      default: initialDefault(
        "quota_routing",
        "AGY_MAGPIE_QUOTA_ROUTING",
        pkgOptions,
        false,
      ),
      labels: {
        zh: "按配额自动多账号路由",
      },
      descriptions: {
        zh: "当某个账号的 5 小时或周配额耗尽时，让 Magpie 自动将后续请求路由到其他已登录账号。",
      },
    },
    {
      key: "cloak_prompts",
      label: "Cloak third-party harness trigger lines",
      description:
        "Strip billing headers and insert zero-width spaces into third-party agent prompt phrases that trigger upstream 429 refusals.",
      default: initialDefault(
        "cloak_prompts",
        "AGY_MAGPIE_CLOAK_PROMPTS",
        pkgOptions,
        true,
      ),
      labels: {
        zh: "自动脱敏第三方客户端提示词",
      },
      descriptions: {
        zh: "移除计费头并对 Claude Code / Codex 等会触发上游伪 429 拒绝的固定标识句插入零宽空格。",
      },
    },
    {
      key: "minimal_agent",
      label: "Minimal agent system prompt",
      description:
        "Set excludeDefaultComponents on the bridge agent to trim ~1.6K native prompt tokens (1,991 -> 389); requests look slightly less like default agy CLI.",
      default: initialDefault(
        "minimal_agent",
        "AGY_MAGPIE_MINIMAL_AGENT",
        pkgOptions,
        false,
      ),
      labels: {
        zh: "精简内置系统提示词",
      },
      descriptions: {
        zh: "开启 excludeDefaultComponents 可再省约 1.6K 内置提示词 Token（从 1,991 降至 389），但上游请求形态与默认 agy 略有差异。",
      },
    },
    {
      key: "expose_thinking",
      label: "Expose thought summaries",
      description:
        "Stream Antigravity ACP thought summaries as Anthropic thinking blocks.",
      default: initialDefault(
        "expose_thinking",
        "AGY_MAGPIE_EXPOSE_THINKING",
        pkgOptions,
        true,
      ),
      labels: {
        zh: "输出思考摘要块",
      },
      descriptions: {
        zh: "将 Antigravity ACP 返回的思考摘要编码为 Anthropic thinking 内容块输出。",
      },
    },
  ];
}

export const PROVIDER_OPTION_SCHEMAS: MagpieOptionSchema[] =
  buildProviderOptionSchemas();

export function readProviderOptions(
  pluginInput?: {
    magpie?: {
      option?: (provider: string, key: string) => boolean | undefined;
      options?: (provider: string) => Record<string, boolean> | undefined;
    };
  },
  pkgOptions?: Record<string, unknown>,
): ProviderOptionsState {
  const fromMagpie = pluginInput?.magpie?.options?.(PROVIDER_ID) ?? {};
  const opt = (key: string, envName: string, fallback: boolean): boolean => {
    const live = pluginInput?.magpie?.option?.(PROVIDER_ID, key);
    if (typeof live === "boolean") return live;
    if (typeof fromMagpie[key] === "boolean") return fromMagpie[key]!;
    return initialDefault(key, envName, pkgOptions, fallback);
  };

  return {
    quotaRouting: opt("quota_routing", "AGY_MAGPIE_QUOTA_ROUTING", false),
    cloakPrompts: opt("cloak_prompts", "AGY_MAGPIE_CLOAK_PROMPTS", true),
    minimalAgent: opt("minimal_agent", "AGY_MAGPIE_MINIMAL_AGENT", false),
    exposeThinking: opt("expose_thinking", "AGY_MAGPIE_EXPOSE_THINKING", true),
  };
}
