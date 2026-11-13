import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Default post-turn RSS ceiling for one live `agy` ACP worker tree.
 *
 * Mirrors Magpie's official Claude bridge (`claude_rss.go`), which parks a
 * session once its process tree grows past a fixed ceiling (host memory / 8,
 * floor 1 GiB). A single `agy` front process measured ~167 MiB on an idle
 * session, so 1 GiB leaves ample headroom for a long tool-heavy turn without
 * letting one conversation pin a gigabyte-scale Go process forever.
 */
export const DEFAULT_MAX_WORKER_RSS_BYTES = 1024 * 1024 * 1024;

/** Reads resident bytes for one Linux pid, preferring `VmRSS` over `statm`. */
function readLinuxPidRssBytes(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s*(\d+)\s*kB/.exec(status);
    if (match && match[1]) {
      const kb = Number(match[1]);
      if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    }
  } catch {}

  // Older/restricted kernels may hide `status`, but `statm` reports resident
  // pages instead. Page size is assumed to be 4 KiB, the only value Linux
  // exposes for the architectures `agy` ships on.
  try {
    const fields = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    const residentPages = Number(fields[1]);
    if (Number.isFinite(residentPages) && residentPages > 0) {
      return residentPages * 4096;
    }
  } catch {}

  return 0;
}

/** Direct children of `pid` according to the `/proc/<pid>/task/*\/children` files. */
function readLinuxChildPids(pid: number): number[] {
  const children: number[] = [];
  let tids: string[];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const tid of tids) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
      for (const token of raw.split(/\s+/)) {
        if (!token) continue;
        const child = Number(token);
        if (Number.isInteger(child) && child > 1) children.push(child);
      }
    } catch {}
  }
  return children;
}

/**
 * Depth-first RSS total for `rootPid` and its descendants. `childrenOf` and
 * `rssBytesOf` supply the platform-specific lookups; a pid reported twice is
 * still only counted once.
 */
function walkTreeRss(
  rootPid: number,
  childrenOf: (pid: number) => readonly number[],
  rssBytesOf: (pid: number) => number,
): number {
  const visited = new Set<number>();
  const stack: number[] = [rootPid];
  let total = 0;
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    total += rssBytesOf(pid);
    for (const child of childrenOf(pid)) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return total;
}

/** Walk `rootPid` and its descendants via `/proc` (no subprocess spawned). */
function sumLinuxTreeRssBytes(rootPid: number): number {
  return walkTreeRss(rootPid, readLinuxChildPids, readLinuxPidRssBytes);
}

/** Walk `rootPid` and its descendants using a single `ps` snapshot. */
function sumPsTreeRssBytes(rootPid: number): number {
  const res = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,rss="], {
    encoding: "utf-8",
    timeout: 1_000,
  });
  if (!res.stdout) return 0;

  const rssByPid = new Map<number, number>();
  const childrenByPpid = new Map<number, number[]>();
  for (const rawLine of res.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 1) continue;
    rssByPid.set(pid, Number.isFinite(rssKb) && rssKb > 0 ? rssKb : 0);
    let siblings = childrenByPpid.get(ppid);
    if (!siblings) {
      siblings = [];
      childrenByPpid.set(ppid, siblings);
    }
    siblings.push(pid);
  }

  return walkTreeRss(
    rootPid,
    (pid) => childrenByPpid.get(pid) ?? [],
    (pid) => (rssByPid.get(pid) ?? 0) * 1024,
  );
}

/**
 * Best-effort resident-set total for one process tree, in bytes.
 *
 * Never throws and returns `0` when the platform cannot be sampled (Windows) or
 * the pid is unusable. Callers treat `0` as "unknown", never as "under limit".
 */
export function measureProcessTreeRssBytes(rootPid: number): number {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return 0;
  if (process.platform === "win32") return 0;

  try {
    if (process.platform === "linux" && fs.existsSync(`/proc/${rootPid}/status`)) {
      return sumLinuxTreeRssBytes(rootPid);
    }
    return sumPsTreeRssBytes(rootPid);
  } catch {
    return 0;
  }
}
