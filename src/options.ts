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

export const PROVIDER_OPTION_SCHEMAS: MagpieOptionSchema[] = [
  {
    key: "quota_routing",
    label: "Quota-aware multi-account routing",
    description:
      "Gate exhausted 5-hour/weekly model buckets so Magpie routes new turns to other signed-in accounts.",
    default: false,
    placement: "top",
    labels: {
      zh: "按配额自动多账号路由",
    },
    descriptions: {
      zh: "当某个账号的 5 小时或周配额耗尽时，让 Magpie 自动将后续请求路由到其他已登录账号。",
    },
  },
  {
    key: "minimal_agent",
    label: "Minimal agent system prompt",
    description:
      "Set excludeDefaultComponents on the isolated bridge agent to reduce native system-prompt token overhead.",
    default: false,
    placement: "top",
    labels: {
      zh: "精简内置系统提示词",
    },
    descriptions: {
      zh: "在隔离桥接 Agent 中开启 excludeDefaultComponents，减少每次调用的内置提示词 Token 开销。",
    },
  },
  {
    key: "expose_thinking",
    label: "Expose thought summaries",
    description:
      "Stream Antigravity ACP thought summaries as Anthropic thinking blocks.",
    default: false,
    placement: "top",
    labels: {
      zh: "输出思考摘要块",
    },
    descriptions: {
      zh: "将 Antigravity ACP 返回的思考摘要编码为 Anthropic thinking 内容块输出。",
    },
  },
];

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}

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
    if (pkgOptions && typeof pkgOptions[key] === "boolean") {
      return pkgOptions[key] as boolean;
    }
    const fromEnv = envBool(envName);
    if (typeof fromEnv === "boolean") return fromEnv;
    return fallback;
  };

  return {
    quotaRouting: opt("quota_routing", "AGY_MAGPIE_QUOTA_ROUTING", false),
    minimalAgent: opt("minimal_agent", "AGY_MAGPIE_MINIMAL_AGENT", false),
    exposeThinking: opt("expose_thinking", "AGY_MAGPIE_EXPOSE_THINKING", false),
  };
}
