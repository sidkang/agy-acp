// Ported from MIT-licensed `packages/agy-cli/cloak.mjs` & volatile-system
// helpers in `packages/agy-cli/index.mjs` (magpie-community/plugins).

const TURNED_AWAY: readonly string[] = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
  "rfc 2119 keywords: must, required, should, recommended, may, optional.",
];

const ZW = "\u200B";

function asciiLower(s: string): string {
  return String(s ?? "").replace(/[A-Z]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 32),
  );
}

export function turnsAway(system: string | undefined | null): boolean {
  const low = String(system ?? "").toLowerCase();
  return TURNED_AWAY.some((l) => low.includes(l));
}

const breakUp = (line: string): string =>
  line.replace(/[A-Za-z0-9]{3,}/g, (w) => w[0]! + ZW + w[1]! + ZW + w.slice(2));

/**
 * Paragraphs that Antigravity accepts without 429 but answers poorly unless reworded
 * with equivalent meaning (e.g. DeepSeek Harness @-path rule, #1028).
 */
const REWORDED: ReadonlyArray<readonly [string, string]> = [
  [
    'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
    'When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @"...".',
  ],
];

function rewordSystemPrompt(system: string): string {
  let out = String(system ?? "");
  for (const [from, to] of REWORDED) {
    if (out.includes(from)) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

/**
 * Strips Claude Code's rotating billing header line before forwarding or comparing.
 */
function stripBillingHeader(text: string | undefined | null): string {
  let s = String(text ?? "");
  s = s.replace(/^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gim, "");
  s = s.replace(/^[ \t]*cch=[0-9a-fA-F]+;?[ \t]*\n?/gim, "");
  return s;
}

const ISO_DATE = String.raw`20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?`;
const LOCALE_DATE = String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?`;
const CLOCK_VALUE = String.raw`(?:${ISO_DATE}|${LOCALE_DATE}|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)`;
const AGENT_CLOCK_LINE_RE = new RegExp(
  String.raw`^(?:#{1,6}\s*)?(?:(?:(?:current\s+)?(?:date|time|datetime|today|now)|today(?:'s)?\s+date|(?:the\s+)?current\s+(?:date|time|datetime))\s*[:\uFF1A]\s*${CLOCK_VALUE}|(?:(?:the\s+)?current\s+(?:date|time|datetime)|today(?:'s)?\s+date)\s+is\s+${CLOCK_VALUE})\s*\.?$`,
  "i",
);

function isAgentClockLine(line: string): boolean {
  return AGENT_CLOCK_LINE_RE.test(String(line ?? "").trim());
}

function stripAgentClockLines(text: string | undefined | null): string {
  const s = String(text ?? "");
  if (!s) return s;
  return s
    .split(/(\n)/)
    .map((part) => (part === "\n" || !isAgentClockLine(part) ? part : ""))
    .join("");
}

/**
 * Strips volatile billing header + agent clock lines for stable session identity.
 */
export function stripVolatileSystem(text: string | undefined | null): string {
  return stripAgentClockLines(stripBillingHeader(text)).trim();
}

/**
 * Strips volatile clock lines only inside `<system-reminder>...</system-reminder>` blocks
 * (and billing header lines) so mid-conversation reminder timestamps never invalidate warm sessions.
 */
export function stripVolatileMessageText(text: string | undefined | null): string {
  const raw = stripBillingHeader(text);
  if (!raw) return raw;
  const openTag = "<system-reminder>";
  const closeTag = "</system-reminder>";
  const low = asciiLower(raw);
  let out = "";
  let pos = 0;
  while (pos < raw.length) {
    const start = low.indexOf(openTag, pos);
    if (start < 0) {
      out += raw.slice(pos);
      break;
    }
    const bodyStart = start + openTag.length;
    const end = low.indexOf(closeTag, bodyStart);
    if (end < 0) {
      out += raw.slice(pos);
      break;
    }
    out += raw.slice(pos, bodyStart);
    out += stripAgentClockLines(raw.slice(bodyStart, end));
    out += raw.slice(end, end + closeTag.length);
    pos = end + closeTag.length;
  }
  return out;
}

/**
 * Strips billing header and inserts zero-width spaces into recognized third-party harness
 * trigger phrases that cause Antigravity's upstream to return fake 429 refusals.
 */
export function cloakSystemPrompt(system: string | undefined | null, enabled = true): string {
  const cleaned = stripBillingHeader(system).trim();
  if (!enabled || !cleaned) return cleaned;
  let cloaked = cleaned;
  if (turnsAway(cloaked)) {
    const low = asciiLower(cloaked);
    const at: Array<[number, number]> = [];
    for (const line of TURNED_AWAY) {
      for (let i = 0; ; ) {
        const j = low.indexOf(line, i);
        if (j < 0) break;
        at.push([j, j + line.length]);
        i = j + line.length;
      }
    }
    at.sort((a, b) => a[0] - b[0]);
    let out = "";
    let prev = 0;
    for (const [from, to] of at) {
      if (from < prev) continue;
      out += cloaked.slice(prev, from) + breakUp(cloaked.slice(from, to));
      prev = to;
    }
    cloaked = out + cloaked.slice(prev);
  }
  return rewordSystemPrompt(cloaked);
}

const HINT =
  "Antigravity rejected this request's system prompt (Claude Code / Claude Agent SDK trigger) with a prompt-level 429 refusal, not an account quota limit; enable cloak_prompts or use another provider for this prompt.";
const CODEX_HINT =
  "Antigravity rejected Codex's GPT-5 system prompt with a prompt-level 429 refusal, not an account quota limit; enable cloak_prompts or start a fresh chat on this model.";
const HERMES_HINT =
  "Antigravity rejected Hermes Agent's legacy default persona prompt with a prompt-level 429 refusal, not an account quota limit.";
const RFC_HINT =
  "Antigravity rejected the RFC 2119 system-prompt trigger line with a prompt-level 429 refusal, not an account quota limit.";

export function refusalHint(system: string | undefined | null): string {
  const low = String(system ?? "").toLowerCase();
  if (low.includes("rfc 2119 keywords: must, required, should, recommended, may, optional.")) {
    return RFC_HINT;
  }
  if (
    low.includes("you are codex, an agent based on gpt-5") ||
    low.includes("you are codex, a coding agent based on gpt-5")
  ) {
    return CODEX_HINT;
  }
  if (low.includes("hermes agent, an intelligent ai assistant created by nous research")) {
    return HERMES_HINT;
  }
  return HINT;
}
