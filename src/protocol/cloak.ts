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

function asciiLower(s: string): string {
  return String(s ?? "").replace(/[A-Z]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 32),
  );
}

/**
 * Characters Google's trigger check reads past when it turns a line away: a line
 * broken up with a zero-width space after the first and second letter of each
 * word (or after every letter), or with U+2060, is still the line (#1028). Since
 * 11-14 the upstream also turns those broken-up copies away, so a bridge must
 * read them (to report the refusal as a prompt, not a quota) and must reword the
 * line rather than break it up.
 */
const INVISIBLE = "[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]";
const INVISIBLE_RE = new RegExp(INVISIBLE, "g");

/**
 * White space as Google's check reads it, with the invisible characters taken
 * out: the two classes must stay disjoint, or one 3200-character run of U+FEFF
 * can be divided between `INVISIBLE*`, `\s+` and `INVISIBLE*` in enough ways to
 * block the thread for twelve seconds (measured on a lone `?` after the run).
 */
const SPACE = "[^\\S\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]";

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One trigger as a matcher that tolerates invisible characters inside each word
 * and any run of white space between words, like Google's own check. Claude
 * Code's billing line is matched to its end, since it goes whole.
 */
function triggerRe(line: string): RegExp {
  const words = line
    .split(" ")
    .map((word) => [...word].map(escapeRe).join(`${INVISIBLE}*`));
  const tail = line === "x-anthropic-billing-header:" ? "[^\n]*\n?" : "";
  return new RegExp(
    words.join(`${INVISIBLE}*${SPACE}+${INVISIBLE}*`) + tail,
    "gi",
  );
}

const TRIGGER_RES: ReadonlyArray<RegExp> = TURNED_AWAY.map((line) =>
  triggerRe(line),
);

function triggerMatches(text: string): boolean[] {
  return TRIGGER_RES.map((re) => {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
  });
}

export function turnsAway(system: string | undefined | null): boolean {
  const text = String(system ?? "");
  return text !== "" && triggerMatches(text).some(Boolean);
}

/**
 * How each turned-away line goes instead, with its invisible characters taken
 * out and its white space kept: a rewording that keeps its meaning. Each was
 * answered on a real account while the line itself, broken up or not, was turned
 * away. Claude Code's billing line is left out of the rewrites: it is Anthropic's
 * and no Antigravity model reads anything in it.
 */
const SAID_AS: ReadonlyArray<(line: string) => string> = [
  () => "",
  (line) =>
    line.replace(
      /^(built\s+on\s+)anthropic's(\s+)(claude\s+agent\s+sdk)$/i,
      "$1the$2$3 by Anthropic",
    ),
  (line) => line.replace(/based(\s+)on/i, "built$1on"),
  (line) => line.replace(/based(\s+)on/i, "built$1on"),
  (line) => line.replace(/created(\s+)by/i, "built$1by"),
  (line) => line.replace(/(key)(words)/i, "$1 $2"),
];

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
 * Strips Claude Code's billing header and rewords recognized third-party harness
 * prompt lines, which Antigravity answers with a 429 to whatever quota is left.
 * Break-up with invisible characters is not a defence: since 11-14 the upstream
 * reads past them and refuses the line all the same.
 */
export function cloakSystemPrompt(system: string | undefined | null, enabled = false): string {
  const cleaned = stripBillingHeader(system).trim();
  if (!enabled || !cleaned) return cleaned;
  let cloaked = cleaned;
  if (turnsAway(cloaked)) {
    const at: Array<[number, number, (line: string) => string]> = [];
    TRIGGER_RES.forEach((re, i) => {
      re.lastIndex = 0;
      for (const match of cloaked.matchAll(re)) {
        const from = match.index ?? 0;
        at.push([from, from + match[0].length, SAID_AS[i]!]);
      }
      re.lastIndex = 0;
    });
    at.sort((a, b) => a[0] - b[0]);
    let out = "";
    let prev = 0;
    for (const [from, to, said] of at) {
      if (from < prev) continue;
      out += cloaked.slice(prev, from) + said(cloaked.slice(from, to).replace(INVISIBLE_RE, ""));
      prev = to;
    }
    cloaked = out + cloaked.slice(prev);
  }
  return rewordSystemPrompt(cloaked);
}

// The wording of these hints goes to Magpie in a `400` body, and Magpie reads
// the whole body for the words that mean a spent window (`quotaWords`,
// `usedUpWords`): it does not read a negation, so "not an account quota limit"
// still answers failQuota and rests a healthy account. Say what happened without
// any of them.
//
// They also have to stop short of a verdict. The refusal a turned-away line draws
// is the same generic answer a real account problem draws (`RESOURCE_EXHAUSTED
// (code 429): Resource has been exhausted`), and this bridge cannot see the
// account's remaining windows, so "the line did it" is a guess: a genuine failure
// that coincided with the line would read the same. The reports behind the trigger
// list say the way to tell them apart is whether the same account still answers
// other requests, which is advice for the reader, not knowledge held here.
const ACCOUNT_STILL_WORKS = "If other requests on this account work,";
const OTHERWISE_ACCOUNT = "if they fail too, it was the account.";

const HINT =
  "This request failed while its system prompt carried Claude Code / Claude Agent SDK wording. " +
  "Antigravity is reported to answer such a request with an error that looks like an account problem, " +
  `so this may not have been the account. ${ACCOUNT_STILL_WORKS} reword or drop that line, or use another ` +
  `provider for this prompt; ${OTHERWISE_ACCOUNT}`;
const CODEX_HINT =
  "This request failed while its system prompt carried the Codex wording for GPT-5 models. " +
  "Antigravity is reported to answer such a request with an error that looks like an account problem, " +
  `so this may not have been the account. ${ACCOUNT_STILL_WORKS} start a fresh chat on this model, or use ` +
  `another provider for it; ${OTHERWISE_ACCOUNT}`;
const HERMES_HINT =
  "This request failed while its system prompt carried the Hermes Agent persona it used by default. " +
  "Antigravity is reported to answer such a request with an error that looks like an account problem, " +
  `so this may not have been the account. ${ACCOUNT_STILL_WORKS} put it in SOUL.md, or use another ` +
  `provider for this prompt; ${OTHERWISE_ACCOUNT}`;
const RFC_HINT =
  "This request failed while its system prompt carried the RFC 2119 line oh-my-pi starts with. " +
  "Antigravity is reported to answer such a request with an error that looks like an account problem, " +
  `so this may not have been the account. ${ACCOUNT_STILL_WORKS} drop that line, or use another provider ` +
  `for this prompt; ${OTHERWISE_ACCOUNT}`;

export function refusalHint(system: string | undefined | null): string {
  const hit = triggerMatches(String(system ?? ""));
  // TURNED_AWAY order: billing, Claude Agent SDK, both Codex lines, Hermes, RFC 2119.
  if (hit[5]) return RFC_HINT;
  if (hit[2] || hit[3]) return CODEX_HINT;
  if (hit[4]) return HERMES_HINT;
  return HINT;
}
