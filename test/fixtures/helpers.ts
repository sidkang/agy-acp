import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { SpawnAgyOptions } from "../../src/accounts/env";
import type { AccountDescriptor } from "../../src/types";

export const FAKE_ACP_PATH = path.resolve(import.meta.dir, "fake-acp.ts");

export function spawnFakeAcp(
  _account: AccountDescriptor,
  args: string[],
  opts?: SpawnAgyOptions,
): ChildProcessWithoutNullStreams {
  return spawn("bun", ["run", FAKE_ACP_PATH, ...args], {
    cwd: opts?.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
