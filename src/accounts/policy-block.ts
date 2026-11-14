/**
 * Accounts the vendor itself has disabled.
 *
 * A suspended Antigravity account does not fail like an expired login: `agy`
 * authenticates normally, then answers the prompt with the suspension sentence as
 * ordinary content. The plugin reports that as a 403, and Magpie fails the turn
 * over to another account, which is the right answer for that request.
 *
 * What must not happen is the next request: without a record, every later turn
 * spawns `agy` again, sends a prompt again, and earns the same refusal — load on an
 * account that cannot answer, and a repeated "third-party software is using this
 * account" signal from the machine. This module keeps that record for the process,
 * so later turns fail fast with the same 403 instead.
 *
 * The block is deliberately short-lived and in memory: an appeal can restore an
 * account, and the plugin has no way to learn about it except by asking `agy`
 * again.
 */

export const POLICY_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;

interface PolicyBlock {
  until: number;
  message: string;
}

const blocks = new Map<string, PolicyBlock>();

/** Records that `agy` answered for this account with a vendor policy refusal. */
export function markPolicyBlocked(
  accountRef: string,
  message: string,
  now: number = Date.now(),
): void {
  if (!accountRef) return;
  blocks.set(accountRef, { until: now + POLICY_BLOCK_TTL_MS, message });
}

/**
 * The refusal this account last answered with, or `null` while it is usable.
 * Expired entries are dropped on read.
 */
export function policyBlockedMessage(
  accountRef: string,
  now: number = Date.now(),
): string | null {
  if (!accountRef) return null;
  const block = blocks.get(accountRef);
  if (!block) return null;
  if (block.until <= now) {
    blocks.delete(accountRef);
    return null;
  }
  return block.message;
}

/** Clears the record after a turn that actually produced work. */
export function clearPolicyBlock(accountRef: string): void {
  if (!accountRef) return;
  blocks.delete(accountRef);
}

/** Test hook: forget every record. */
export function resetPolicyBlocks(): void {
  blocks.clear();
}
