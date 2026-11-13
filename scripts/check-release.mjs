// Release gate for the `magpie-agy-acp` package (provider ID `agy-acp`): the
// things that used to be checked by hand before a tag, in one command.
//
//   bun scripts/check-release.mjs [--tag v0.1.7]
//
// It checks the manifest and packaging rules `magpie-community/plugins` applies
// (`scripts/check.mjs` and `scripts/registry.mjs` there), the OpenCode 1.x /
// Magpie plugin-host contract of `opencode.mjs`, the OpenCode 2.x face of
// `opencode2.mjs`, repository language & gitignore hygiene, the tarball npm
// would ship, and — when a tag is given — that the tag names this version.
//
// Every plugin load happens under a throwaway HOME so no check can reach the
// real `~/.gemini`, and no check signs in to anything or spawns `agy`.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "magpie-agy-acp";
const PROVIDER_ID = "agy-acp";
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const HAN_RE = /\p{Script=Han}/u;
const CJK_RE = /[\p{Script=Han}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u;

const root = path.resolve(import.meta.dir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const problems = [];
const checked = [];
const ok = (what, detail) => checked.push(detail ? `${what}: ${detail}` : what);
const bad = (what) => problems.push(what);
const okIfClean = (before, what, detail) => {
  if (problems.length === before) ok(what, detail);
};

const isValidPkgName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 214 &&
  PKG_NAME_RE.test(name);

// ---- the tag, when one is given -------------------------------------------

const argv = process.argv.slice(2);
const tagFlag = argv.indexOf("--tag");
const rawTag =
  tagFlag >= 0 ? argv[tagFlag + 1] : process.env.RELEASE_TAG || undefined;
if (tagFlag >= 0 && !rawTag) bad("--tag needs a value");

if (rawTag) {
  const tag = rawTag.replace(/^refs\/tags\//, "");
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    bad(`tag ${JSON.stringify(tag)} is not v<major>.<minor>.<patch>`);
  } else if (tag !== `v${pkg.version}`) {
    bad(`tag ${tag} does not name package.json's version v${pkg.version}`);
  } else {
    ok("tag", tag);
  }
}

// ---- package.json ---------------------------------------------------------

{
  const before = problems.length;
  if (pkg.name === "agy-acp") {
    bad('package.json name must not be "agy-acp" (collides with unrelated package on npm)');
  } else if (!isValidPkgName(pkg.name)) {
    bad(`package.json name ${JSON.stringify(pkg.name)} is not a valid npm package name`);
  } else if (pkg.name !== PACKAGE_NAME) {
    bad(`package.json name is ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(PACKAGE_NAME)}`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ""))
    bad(`package.json version ${JSON.stringify(pkg.version)} is not semver`);
  if (pkg.version && !pkg.version.startsWith("0.1."))
    bad(`version ${pkg.version} left the 0.1.x series this plugin ships on`);
  if (pkg.license !== "MIT") bad("package.json license must be MIT");
  if (pkg.type !== "module") bad('package.json type must be "module"');
  if (pkg.main !== "./opencode.mjs")
    bad('package.json main must be "./opencode.mjs"');
  if (pkg.exports?.["."] !== "./opencode2.mjs")
    bad('package.json exports["."] must be "./opencode2.mjs" (OpenCode 2.x)');
  if (pkg.exports?.["./server"] !== "./opencode.mjs")
    bad('package.json exports["./server"] must be "./opencode.mjs" (Magpie host)');
  if (pkg.dependencies && Object.keys(pkg.dependencies).length)
    // The community repository's CI runs `bun test` and `bun scripts/check.mjs`
    // without installing anything, so a runtime dependency would make the plugin
    // uninstallable there.
    bad(
      `package.json declares runtime dependencies (${Object.keys(pkg.dependencies).join(", ")}); ` +
        "the plugin must run on Node/Bun built-ins alone",
    );
  okIfClean(before, "package.json", `${pkg.name}@${pkg.version}`);
}

const files = Array.isArray(pkg.files) ? pkg.files : [];
{
  const before = problems.length;
  const required = [
    "opencode.mjs",
    "opencode2.mjs",
    "src",
    "assets",
    "docs/claude-bridge-parity.md",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "NOTICE.md",
  ];
  const covers = (entry) =>
    files.some((f) => {
      const clean = f.replace(/^\.\//, "").replace(/\/$/, "");
      return clean === entry || entry.startsWith(`${clean}/`);
    });
  for (const entry of required) {
    if (!covers(entry)) bad(`package.json files does not ship ${entry}`);
  }
  if (files.some((f) => f.replace(/^\.\//, "").replace(/\/$/, "") === "docs")) {
    bad('package.json files must not ship the whole "docs" directory');
  }
  for (const entry of files) {
    const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!clean) {
      bad("package.json files has an empty entry");
      continue;
    }
    if (!fs.existsSync(path.join(root, clean))) bad(`files entry ${entry} is missing on disk`);
  }
  okIfClean(before, "files", `${files.length} entries`);
}

const magpie = pkg.magpie ?? {};
{
  const before = problems.length;
  if (!magpie.name) bad("magpie.name is missing");
  if (typeof magpie.icon !== "string" || !/^(https:\/\/|data:image\/)/.test(magpie.icon))
    bad("magpie.icon must be an https:// or data:image/ URL");
  if (magpie.maxConcurrency !== 18)
    bad(`magpie.maxConcurrency must be 18 (per-account), got ${String(magpie.maxConcurrency)}`);
  const expectedOptions = {
    maxGlobalWorkers: 36,
    maxPerAccountWorkers: 18,
    idleTimeoutMs: 3600000,
    awaitingToolTimeoutMs: 600000,
    waitTimeoutMs: 60000,
    maxWaiters: 128,
    maxWorkerRssBytes: 1073741824,
  };
  const actualOptions =
    magpie.options && typeof magpie.options === "object" && !Array.isArray(magpie.options)
      ? magpie.options
      : {};
  for (const [k, v] of Object.entries(expectedOptions)) {
    if (actualOptions[k] !== v) {
      bad(`magpie.options.${k} must be ${v}, got ${String(actualOptions[k])}`);
    }
  }
  for (const k of Object.keys(actualOptions)) {
    if (!(k in expectedOptions)) bad(`magpie.options has unexpected key ${JSON.stringify(k)}`);
  }
  for (const lang of ["en", "zh"]) {
    if (typeof magpie.summary?.[lang] !== "string" || !magpie.summary[lang].trim())
      bad(`magpie.summary.${lang} is missing`);
  }
  okIfClean(before, "magpie", `${magpie.name}, maxConcurrency ${magpie.maxConcurrency}`);
}

// ---- magpie-community/plugins registry.json contract ----------------------

{
  const before = problems.length;
  const registryEntry = {
    package: pkg.name,
    name: magpie.name,
    icon: magpie.icon,
    providers: [PROVIDER_ID],
    summary: magpie.summary,
  };
  const knownFields = new Set(["package", "name", "icon", "providers", "summary"]);
  for (const key of Object.keys(registryEntry)) {
    if (!knownFields.has(key)) bad(`registry entry has unknown field ${JSON.stringify(key)}`);
  }
  if (!isValidPkgName(registryEntry.package) || registryEntry.package === "agy-acp") {
    bad(`registry entry package ${JSON.stringify(registryEntry.package)} is invalid or collides on npm`);
  }
  if (typeof registryEntry.name !== "string" || !registryEntry.name.trim()) {
    bad("registry entry name must be a non-empty string");
  }
  if (
    typeof registryEntry.icon !== "string" ||
    !/^(https:\/\/|data:image\/)/.test(registryEntry.icon)
  ) {
    bad("registry entry icon must be an https:// or data:image/ URL");
  }
  if (
    !Array.isArray(registryEntry.providers) ||
    registryEntry.providers.length === 0 ||
    !registryEntry.providers.every(
      (p) => typeof p === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(p),
    ) ||
    new Set(registryEntry.providers).size !== registryEntry.providers.length ||
    !registryEntry.providers.includes(PROVIDER_ID)
  ) {
    bad(`registry entry providers must be a unique valid array containing ${PROVIDER_ID}`);
  }
  const summary = registryEntry.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    bad("registry entry summary must be an object");
  } else {
    for (const k of Object.keys(summary)) {
      if (k !== "en" && k !== "zh") bad(`registry entry summary has unknown locale ${JSON.stringify(k)}`);
    }
    const en = typeof summary.en === "string" ? summary.en.trim() : "";
    const zh = typeof summary.zh === "string" ? summary.zh.trim() : "";
    if (!en) bad("registry entry summary.en must be non-empty");
    if (!zh) bad("registry entry summary.zh must be non-empty");
    if (en && CJK_RE.test(en)) bad("registry entry summary.en must not contain CJK characters");
    if (zh && !HAN_RE.test(zh)) bad("registry entry summary.zh must contain Chinese characters");
    // plugins#614: overlapping Antigravity providers must state shared quota pool
    // with `antigravity` & `agy-cli` and explain technical differentiation.
    if (
      en &&
      (!/\bantigravity\b/.test(en) ||
        !/\bagy-cli\b/.test(en) ||
        !/quota/i.test(en) ||
        !/multi-account/i.test(en) ||
        !/\bagy acp\b/i.test(en))
    ) {
      bad(
        "registry entry summary.en must note shared quota pool with antigravity & agy-cli and multi-account ACP differentiation (plugins#614)",
      );
    }
    if (
      zh &&
      (!/\bantigravity\b/.test(zh) ||
        !/\bagy-cli\b/.test(zh) ||
        !/(\u989d\u5ea6|\u914d\u989d)/.test(zh) ||
        !/\u591a\u8d26\u53f7/.test(zh) ||
        !/\bagy acp\b/i.test(zh))
    ) {
      bad(
        "registry entry summary.zh must note shared quota pool with antigravity & agy-cli and multi-account ACP differentiation (plugins#614)",
      );
    }
  }
  okIfClean(before, "registry entry", `${registryEntry.package} -> [${registryEntry.providers.join(", ")}]`);
}

// ---- .gitignore hygiene ---------------------------------------------------

{
  const before = problems.length;
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    bad(".gitignore is missing");
  } else {
    const entries = fs
      .readFileSync(gitignorePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const hasAgentsMd = entries.some((e) => e === "AGENTS.md" || e === "/AGENTS.md");
    if (!hasAgentsMd) bad(".gitignore must list AGENTS.md");
  }
  if (fs.existsSync(path.join(root, ".jj"))) {
    try {
      const tracked = execFileSync("jj", ["file", "list", "AGENTS.md"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
      if (tracked) bad("AGENTS.md must remain untracked in jj");
    } catch {}
  } else if (fs.existsSync(path.join(root, ".git"))) {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "AGENTS.md"], {
        cwd: root,
        stdio: "ignore",
        timeout: 10_000,
      });
      bad("AGENTS.md must remain untracked in git");
    } catch {}
  }
  okIfClean(before, ".gitignore", "lists AGENTS.md (untracked)");
}

// ---- the OpenCode 2.x face ------------------------------------------------

const opencode2 = path.join(root, "opencode2.mjs");
if (!fs.existsSync(opencode2)) {
  bad("opencode2.mjs is missing");
} else {
  const before = problems.length;
  const bytes = fs.readFileSync(opencode2);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const mod = await import(pathToFileURL(opencode2).href);
  const d = mod.default;
  if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id)
    bad("opencode2.mjs default must be { id, setup }");
  else if (d.id !== PACKAGE_NAME)
    bad(`opencode2.mjs id ${d.id} is not ${PACKAGE_NAME}`);
  if (typeof d?.setup !== "function") bad("opencode2.mjs default.setup must be a function");
  okIfClean(before, "opencode2.mjs", `id ${d?.id}, sha256 ${sha.slice(0, 16)}…`);
}

// ---- the OpenCode 1.x / Magpie host contract ------------------------------

// A throwaway HOME so loading the plugin can never read a real sign-in.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-release-"));
const sandboxEnvKeys = [
  "HOME",
  "AGY_ACP_DATA_DIR",
  "ANTIGRAVITY_MAGPIE_DATA_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "BROWSER",
];
const prevEnv = Object.fromEntries(sandboxEnvKeys.map((k) => [k, process.env[k]]));
try {
  process.env.HOME = sandbox;
  process.env.AGY_ACP_DATA_DIR = path.join(sandbox, "plugin-data");
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = path.join(sandbox, "plugin-data");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
  process.env.BROWSER = "/usr/bin/false";

  const mod = await import(pathToFileURL(path.join(root, "opencode.mjs")).href);
  const server = mod.default?.server;
  if (typeof server !== "function") {
    bad("opencode.mjs default.server must be a function");
  } else if (mod.default.id !== PROVIDER_ID) {
    bad(`opencode.mjs id ${mod.default.id} is not ${PROVIDER_ID}`);
  } else {
    const stray = Object.entries(mod).filter(
      ([, v]) => typeof v !== "function" && typeof v?.server !== "function",
    );
    if (stray.length)
      // OpenCode 1.x refuses a main that exports anything but plugins.
      bad(`opencode.mjs exports ${stray.map(([k]) => k).join(", ")}, which OpenCode 1.x refuses`);

    const client = {
      app: { log: async () => {} },
      auth: { set: async () => {} },
      tui: { showToast: async () => {} },
      config: { get: async () => ({ data: {} }) },
    };
    const hooks = await server({
      client,
      directory: root,
      worktree: root,
      $: undefined,
      project: {},
    });

    const auth = hooks?.auth;
    if (!auth) bad("plugin returns no auth hook");
    else {
      const before = problems.length;
      if (auth.provider !== PROVIDER_ID) bad(`auth.provider is ${String(auth.provider)}`);
      if (auth.maxConcurrency !== 18)
        bad(`auth.maxConcurrency must default to 18, got ${String(auth.maxConcurrency)}`);
      if (typeof auth.loader !== "function") bad("auth.loader must be a function");
      if (typeof auth.usage !== "function") bad("auth.usage must be a function");
      if (!Array.isArray(auth.methods) || auth.methods.length === 0)
        bad("auth.methods must not be empty");
      for (const m of auth.methods ?? []) {
        if (!["oauth", "api"].includes(m?.type))
          bad(`auth method ${JSON.stringify(m?.label)} has type ${m?.type}`);
        if (m?.type === "oauth" && typeof m.authorize !== "function")
          bad(`auth method ${JSON.stringify(m?.label)} has no authorize`);
      }
      okIfClean(before, "auth", `provider ${auth.provider}, maxConcurrency ${auth.maxConcurrency}, ${auth.methods?.length ?? 0} methods`);
    }

    const cfg = { provider: {} };
    await hooks?.config?.(cfg);
    const entry = cfg.provider?.[PROVIDER_ID];
    if (!entry) bad(`config hook did not configure provider ${PROVIDER_ID}`);
    else if (!entry.npm && !entry.models)
      bad(`config gives ${PROVIDER_ID} no npm or models`);
    else ok("config", `provider ${PROVIDER_ID}, npm ${String(entry.npm)}`);

    {
      const before = problems.length;
      if (hooks?.provider?.id !== PROVIDER_ID) bad("provider hook id does not match PROVIDER_ID");
      if (typeof hooks?.provider?.models !== "function") bad("provider.models must be a function");
      okIfClean(before, "provider", `id ${PROVIDER_ID}, models() present`);
    }
  }

  // ---- strict field-level English-only hygiene ----------------------------
  {
    const before = problems.length;
    const optionsMod = await import(pathToFileURL(path.join(root, "src/options.ts")).href);
    const authMod = await import(pathToFileURL(path.join(root, "src/accounts/auth.ts")).href);

    const allowedByFile = new Map([
      ["package.json", []],
      ["src/options.ts", []],
      ["src/accounts/auth.ts", []],
    ]);

    if (typeof pkg.magpie?.summary?.zh === "string") {
      allowedByFile.get("package.json").push(pkg.magpie.summary.zh);
    }

    const pkgClone = structuredClone(pkg);
    if (pkgClone?.magpie?.summary && typeof pkgClone.magpie.summary === "object") {
      delete pkgClone.magpie.summary.zh;
    }
    if (CJK_RE.test(JSON.stringify(pkgClone))) {
      bad("package.json contains CJK characters outside magpie.summary.zh");
    }

    const optionSchemas =
      typeof optionsMod.buildProviderOptionSchemas === "function"
        ? optionsMod.buildProviderOptionSchemas(pkg.magpie?.options)
        : [];
    for (const opt of optionSchemas) {
      for (const [field, val] of [
        ["label", opt.label],
        ["description", opt.description],
        ["confirm", opt.confirm],
      ]) {
        if (typeof val === "string" && CJK_RE.test(val)) {
          bad(`src/options.ts option ${opt.key}.${field} contains CJK characters`);
        }
      }
      for (const dict of [opt.labels, opt.descriptions, opt.confirms]) {
        if (!dict || typeof dict !== "object") continue;
        for (const [locale, val] of Object.entries(dict)) {
          if (typeof val !== "string") continue;
          if (locale === "zh" || locale === "zh-TW") {
            allowedByFile.get("src/options.ts").push(val);
          } else if (CJK_RE.test(val)) {
            bad(`src/options.ts option ${opt.key} (${locale}) contains unexpected CJK characters`);
          }
        }
      }
    }

    if (typeof authMod.IMPORT_FROM_EN !== "string" || CJK_RE.test(authMod.IMPORT_FROM_EN)) {
      bad("src/accounts/auth.ts IMPORT_FROM_EN is missing or contains CJK characters");
    }
    for (const [locale, val] of Object.entries(authMod.IMPORT_FROMS ?? {})) {
      if (typeof val !== "string") continue;
      if (locale === "zh" || locale === "zh-TW") {
        allowedByFile.get("src/accounts/auth.ts").push(val);
      } else if (CJK_RE.test(val)) {
        bad(`src/accounts/auth.ts IMPORT_FROMS.${locale} contains unexpected CJK characters`);
      }
    }

    const skipDirs = new Set([".git", ".jj", "node_modules", ".sandbox"]);
    const findFirstCjkLine = (source) => {
      const lines = source.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (CJK_RE.test(lines[i])) return i + 1;
      }
      return 0;
    };

    let scannedFiles = 0;
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (!skipDirs.has(ent.name)) walk(path.join(dir, ent.name));
          continue;
        }
        if (!ent.isFile() || ent.name.endsWith(".tgz")) continue;
        const abs = path.join(dir, ent.name);
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (rel === "README.zh-CN.md") continue;
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) continue;
        scannedFiles++;
        let text = buf.toString("utf8");
        const allowed = allowedByFile.get(rel);
        if (allowed) {
          for (const str of allowed) {
            const lit = JSON.stringify(str);
            const idx = text.indexOf(lit);
            if (idx >= 0) {
              text = `${text.slice(0, idx)}""${text.slice(idx + lit.length)}`;
            }
          }
        }
        const line = findFirstCjkLine(text);
        if (line > 0) {
          bad(`${rel}:${line} contains unexpected CJK or fullwidth characters`);
        }
      }
    };
    walk(root);
    okIfClean(before, "language hygiene", `${scannedFiles} files verified English-only (outside localization)`);
  }
} catch (err) {
  bad(`loading the plugin threw: ${String(err?.stack ?? err).split("\n")[0]}`);
} finally {
  for (const key of sandboxEnvKeys) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ---- the tarball ----------------------------------------------------------

let npmAvailable = false;
try {
  execFileSync("npm", ["--version"], { stdio: "ignore", timeout: 20_000 });
  npmAvailable = true;
} catch {}
if (!npmAvailable) {
  ok("npm pack", "skipped (npm not on PATH)");
} else {
  try {
    const before = problems.length;
    const out = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    const packed = (Array.isArray(parsed) ? parsed[0]?.files ?? [] : []).map((f) => f.path);
    const need = [
      "package.json",
      "opencode.mjs",
      "opencode2.mjs",
      "src/index.ts",
      "assets/icon.svg",
      "docs/claude-bridge-parity.md",
      "README.md",
      "README.zh-CN.md",
      "LICENSE",
      "NOTICE.md",
    ];
    for (const f of need) if (!packed.includes(f)) bad(`npm pack omits ${f}`);
    const forbidden = packed.filter(
      (f) =>
        f === "AGENTS.md" ||
        f.startsWith("test/") ||
        f.startsWith(".github/") ||
        f.startsWith(".jj/") ||
        f.startsWith(".sandbox/") ||
        f.startsWith("scripts/") ||
        (f.startsWith("docs/") && f !== "docs/claude-bridge-parity.md") ||
        f === ".env" ||
        f.endsWith(".lock") ||
        /(^|\/)parked-sessions\.json$/.test(f),
    );
    if (forbidden.length) bad(`npm pack ships ${forbidden.slice(0, 5).join(", ")}`);
    okIfClean(before, "npm pack", `${packed.length} files`);
  } catch (err) {
    bad(`npm pack --dry-run failed: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}

// ---- report ---------------------------------------------------------------

for (const line of checked) console.log(`✓ ${line}`);
if (problems.length) {
  for (const problem of problems) console.log(`✗ ${problem}`);
  console.log(
    `\n${problems.length} problem(s); ${checked.length} check(s) passed. The release must not be tagged.`,
  );
  process.exit(1);
}
console.log(`\n${checked.length} check(s) passed. ${pkg.name}@${pkg.version} is releasable.`);
