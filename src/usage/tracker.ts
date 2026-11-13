import fs from "node:fs";
import type { AccountDescriptor, TokenUsageSummary } from "../types";
import {
  readConversationStepUsages,
  resolveConversationDbPath,
  settleStepUsage,
  type StepTokenUsage,
} from "./step-usage";

/**
 * Where a worker is in `agy`'s own per-step token ledger.
 *
 * ACP reports one `usage` per `session/prompt`, but a prompt that called tools
 * ran several model steps, and that number is the sum over all of them. Handing
 * it to the caller as-is multiplies the visible context by the number of steps.
 * `agy` writes the real per-step numbers to its conversation SQLite database,
 * so this tracker keeps three things: the last step index already reported, how
 * many steps the prompt in flight has run, and the usage of prompts whose
 * numbers arrived while the caller could not be told (a cancelled steer turn).
 *
 * All of it used to live in `AgySessionWorker` as loose fields read and written
 * from four callbacks, which is why a suppressed turn could report the same step
 * twice.
 */
export function emptyUsage(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function addUsage(into: TokenUsageSummary, usage: TokenUsageSummary): void {
  into.inputTokens += usage.inputTokens;
  into.outputTokens += usage.outputTokens;
  into.cacheReadInputTokens += usage.cacheReadInputTokens;
  into.cacheCreationInputTokens += usage.cacheCreationInputTokens;
}

export interface ReadUnseenStepsOptions {
  /** Stops the WAL retry loop once the worker is gone. */
  isClosed?: () => boolean;
}

export class StepUsageTracker {
  private lastReportedStepIdx = -1;
  private stepCountInPrompt = 1;
  private unreported: TokenUsageSummary = emptyUsage();

  /** Index of the newest step already accounted for, `-1` before the first. */
  get lastStepIdx(): number {
    return this.lastReportedStepIdx;
  }

  /** How many model steps the prompt in flight has run. */
  get promptStepCount(): number {
    return this.stepCountInPrompt;
  }

  /** A tool batch ended a step: the next prompt's usage covers one more. */
  incrementPromptStepCount(): void {
    this.stepCountInPrompt += 1;
  }

  resetPromptStepCount(): void {
    this.stepCountInPrompt = 1;
  }

  /**
   * Adopts a *resumed* native session: its earlier steps are already on the
   * caller's ledger from before the shelf, so they must not be reported again.
   */
  syncExistingConversation(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): void {
    try {
      const steps = readConversationStepUsages(account, nativeSessionId);
      if (steps.length > 0) {
        this.lastReportedStepIdx = steps[steps.length - 1]!.idx;
      }
    } catch {}
  }

  readUnseenStepsSync(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): StepTokenUsage[] {
    if (!nativeSessionId) return [];
    let steps: StepTokenUsage[];
    try {
      steps = readConversationStepUsages(account, nativeSessionId);
    } catch {
      return [];
    }
    const unseen = steps.filter((s) => s.idx > this.lastReportedStepIdx);
    if (unseen.length > 0) {
      this.lastReportedStepIdx = unseen[unseen.length - 1]!.idx;
    }
    return unseen;
  }

  /**
   * Reads the steps `agy` has committed for this prompt, waiting briefly for the
   * conversation DB's WAL frame to land: a tool batch is settled while the CLI is
   * still flushing it, so the first read often sees nothing yet.
   */
  async readUnseenStepsWithRetry(
    account: AccountDescriptor,
    nativeSessionId: string,
    retries = 3,
    delayMs = 25,
    options?: ReadUnseenStepsOptions,
  ): Promise<StepTokenUsage[]> {
    let unseen = this.readUnseenStepsSync(account, nativeSessionId);
    if (unseen.length > 0 || !nativeSessionId) return unseen;

    let dbPath: string | null = null;
    try {
      dbPath = resolveConversationDbPath(account, nativeSessionId);
    } catch {
      dbPath = null;
    }
    if (!dbPath || !fs.existsSync(dbPath)) return unseen;

    for (let attempt = 0; attempt < retries; attempt++) {
      if (options?.isClosed?.()) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      unseen = this.readUnseenStepsSync(account, nativeSessionId);
      if (unseen.length > 0) break;
    }
    return unseen;
  }

  /** Keeps usage that arrived while the caller could not be told about it. */
  bankUnreported(usage: TokenUsageSummary): void {
    addUsage(this.unreported, usage);
  }

  /** Settles a prompt and adds whatever was banked meanwhile, exactly once. */
  drainWithUnreported(usage: TokenUsageSummary): TokenUsageSummary {
    const total: TokenUsageSummary = {
      inputTokens: usage.inputTokens + this.unreported.inputTokens,
      outputTokens: usage.outputTokens + this.unreported.outputTokens,
      cacheReadInputTokens:
        usage.cacheReadInputTokens + this.unreported.cacheReadInputTokens,
      cacheCreationInputTokens:
        usage.cacheCreationInputTokens + this.unreported.cacheCreationInputTokens,
    };
    this.unreported = emptyUsage();
    return total;
  }

  /**
   * The usage of a prompt that just finished: the exact step measurement when
   * `agy` has written one, else the prompt's total divided across its steps.
   */
  settlePromptTurn(
    account: AccountDescriptor,
    nativeSessionId: string,
    rpcUsage: unknown,
  ): TokenUsageSummary {
    const unseen = this.readUnseenStepsSync(account, nativeSessionId);
    const settled = settleStepUsage(
      rpcUsage,
      this.stepCountInPrompt,
      unseen.length > 0 ? unseen : undefined,
    );
    this.stepCountInPrompt = 1;
    return settled;
  }

  /**
   * A prompt cancelled for steering finished anyway: bank its usage instead of
   * reporting it, and only for the steps not already accounted for.
   */
  bankSuppressedPromptTurn(
    account: AccountDescriptor,
    nativeSessionId: string,
    rpcUsage: unknown,
  ): void {
    try {
      const unseen = this.readUnseenStepsSync(account, nativeSessionId);
      const settled = settleStepUsage(
        rpcUsage,
        this.stepCountInPrompt,
        unseen.length > 0 ? unseen : undefined,
      );
      this.stepCountInPrompt = 1;
      this.bankUnreported(settled);
    } catch {}
  }
}
