// Release gate for the `agy-acp` package: the things that used to be checked by
// hand before a tag, in one command.
//
//   bun scripts/check-release.mjs [--tag v0.1.5]
//
// It checks the manifest and packaging rules `magpie-community/plugins` applies
// (`scripts/check.mjs` there), the OpenCode 1.x / Magpie plugin-host contract of
// `opencode.mjs`, the OpenCode 2.x face of `opencode2.mjs`, the tarball npm
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

const root = path.resolve(import.meta.dir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const problems = [];
const checked = [];
const ok = (what, detail) => checked.push(detail ? `${what}: ${detail}` : what);
const bad = (what) => problems.push(what);

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

if (pkg.name !== "agy-acp") bad(`package.json name is ${JSON.stringify(pkg.name)}`);
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
ok("package.json", `${pkg.name}@${pkg.version}`);

const files = Array.isArray(pkg.files) ? pkg.files : [];
const required = [
  "opencode.mjs",
  "opencode2.mjs",
  "src",
  "assets",
  "README.md",
  "LICENSE",
];
const covers = (entry) =>
  files.some((f) => {
    const clean = f.replace(/^\.\//, "").replace(/\/$/, "");
    return clean === entry || entry.startsWith(`${clean}/`);
  });
for (const entry of required) {
  if (!covers(entry)) bad(`package.json files does not ship ${entry}`);
}
for (const entry of files) {
  const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
  if (!clean) {
    bad("package.json files has an empty entry");
    continue;
  }
  if (!fs.existsSync(path.join(root, clean))) bad(`files entry ${entry} is missing on disk`);
}
ok("files", `${files.length} entries`);

const magpie = pkg.magpie ?? {};
if (!magpie.name) bad("magpie.name is missing");
if (typeof magpie.icon !== "string" || !/^(https:\/\/|data:image\/)/.test(magpie.icon))
  bad("magpie.icon must be an https:// or data:image/ URL");
if (!Number.isInteger(magpie.maxConcurrency) || magpie.maxConcurrency <= 0)
  bad("magpie.maxConcurrency must be a positive integer");
for (const lang of ["en", "zh"]) {
  if (typeof magpie.summary?.[lang] !== "string" || !magpie.summary[lang].trim())
    bad(`magpie.summary.${lang} is missing`);
}
ok("magpie", `${magpie.name}, maxConcurrency ${magpie.maxConcurrency}`);

// ---- the OpenCode 2.x face ------------------------------------------------

const opencode2 = path.join(root, "opencode2.mjs");
if (!fs.existsSync(opencode2)) {
  bad("opencode2.mjs is missing");
} else {
  const bytes = fs.readFileSync(opencode2);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const mod = await import(pathToFileURL(opencode2).href);
  const d = mod.default;
  if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id)
    bad('opencode2.mjs default must be { id, setup }');
  else if (d.id !== pkg.name) bad(`opencode2.mjs id ${d.id} is not ${pkg.name}`);
  if (typeof d?.setup !== "function") bad("opencode2.mjs default.setup must be a function");
  ok("opencode2.mjs", `sha256 ${sha.slice(0, 16)}…`);
}

// ---- the OpenCode 1.x / Magpie host contract ------------------------------

// A throwaway HOME so loading the plugin can never read a real sign-in.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-release-"));
const prevEnv = { ...process.env };
const prevHome = process.env.HOME;
try {
  process.env.HOME = sandbox;
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = path.join(sandbox, "plugin-data");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
  process.env.BROWSER = "/usr/bin/false";

  const mod = await import(pathToFileURL(path.join(root, "opencode.mjs")).href);
  const server = mod.default?.server;
  if (typeof server !== "function") {
    bad("opencode.mjs default.server must be a function");
  } else if (mod.default.id !== pkg.name) {
    bad(`opencode.mjs id ${mod.default.id} is not ${pkg.name}`);
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
      if (auth.provider !== pkg.name) bad(`auth.provider is ${String(auth.provider)}`);
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
      ok("auth", `${auth.methods?.length ?? 0} methods`);
    }

    const cfg = { provider: {} };
    await hooks?.config?.(cfg);
    const entry = cfg.provider?.[pkg.name];
    if (!entry) bad(`config hook did not configure provider ${pkg.name}`);
    else if (!entry.npm && !entry.models)
      bad(`config gives ${pkg.name} no npm or models`);
    else ok("config", `npm ${String(entry.npm)}`);

    if (hooks?.provider?.id !== pkg.name) bad("provider hook id does not match the plugin id");
    if (typeof hooks?.provider?.models !== "function") bad("provider.models must be a function");
    else ok("provider", "models() present");
  }
} catch (err) {
  bad(`loading the plugin threw: ${String(err?.stack ?? err).split("\n")[0]}`);
} finally {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  for (const key of ["ANTIGRAVITY_MAGPIE_DATA_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
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
      "README.md",
      "LICENSE",
    ];
    for (const f of need) if (!packed.includes(f)) bad(`npm pack omits ${f}`);
    const forbidden = packed.filter(
      (f) =>
        f.startsWith("test/") ||
        f.startsWith(".github/") ||
        f.startsWith(".jj/") ||
        f.startsWith("scripts/") ||
        f === ".env" ||
        f.endsWith(".lock") ||
        /(^|\/)parked-sessions\.json$/.test(f),
    );
    if (forbidden.length) bad(`npm pack ships ${forbidden.slice(0, 5).join(", ")}`);
    ok("npm pack", `${packed.length} files`);
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
