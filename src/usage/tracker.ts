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

function subtractUsage(
  total: TokenUsageSummary,
  reported: TokenUsageSummary,
): TokenUsageSummary {
  return {
    inputTokens: Math.max(0, total.inputTokens - reported.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - reported.outputTokens),
    cacheReadInputTokens: Math.max(
      0,
      total.cacheReadInputTokens - reported.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: Math.max(
      0,
      total.cacheCreationInputTokens - reported.cacheCreationInputTokens,
    ),
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

/** A prompt cannot have more steps than this without the rows being long gone. */
const MAX_ABSORBED_PENDING = 16;

export class StepUsageTracker {
  private lastReportedStepIdx = -1;
  private stepCountInPrompt = 1;
  private unreported: TokenUsageSummary = emptyUsage();
  /** Usage this turn already handed the caller, from a tool-batch settlement. */
  private turnReported: TokenUsageSummary = emptyUsage();
  /**
   * Steps a prompt result already accounted for whose step rows had not landed
   * yet. `agy` commits those rows a moment after the prompt settles, so the cursor
   * taken at settlement cannot cover them; without this, the next turn reads them
   * as its own work and reports a prompt's usage twice.
   */
  private absorbedPending = 0;

  /** Index of the newest step already accounted for, `-1` before the first. */
  get lastStepIdx(): number {
    return this.lastReportedStepIdx;
  }

  /** A tool batch ended a step: the next prompt's usage covers one more. */
  incrementPromptStepCount(): void {
    this.stepCountInPrompt += 1;
  }

  /**
   * Adopts a *resumed* native session: its earlier steps are already on the
   * caller's ledger from before the shelf, so they must not be reported again.
   */
  syncExistingConversation(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): void {
    const steps = readConversationStepUsages(account, nativeSessionId);
    if (steps.length > 0) {
      this.lastReportedStepIdx = steps[steps.length - 1]!.idx;
    }
  }

  readUnseenStepsSync(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): StepTokenUsage[] {
    if (!nativeSessionId) return [];
    const steps = readConversationStepUsages(account, nativeSessionId);
    const unseen = steps.filter((s) => s.idx > this.lastReportedStepIdx);
    if (unseen.length === 0) return [];
    // Rows ordered by idx, so the ones a settled prompt was already paid for are
    // the oldest unseen ones. They are dropped rather than reported again.
    let reported = unseen;
    if (this.absorbedPending > 0) {
      const absorbed = Math.min(this.absorbedPending, unseen.length);
      this.absorbedPending -= absorbed;
      reported = unseen.slice(absorbed);
    }
    this.lastReportedStepIdx = unseen[unseen.length - 1]!.idx;
    return reported;
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
    if (unseen.length > 0) return unseen;

    const dbPath = resolveConversationDbPath(account, nativeSessionId);
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

  /** Records usage a tool batch already reported this turn. */
  noteTurnReported(usage: TokenUsageSummary): void {
    addUsage(this.turnReported, usage);
  }

  /**
   * Settles a prompt whose exact usage the protocol reported.
   *
   * The prompt result covers the whole turn, tool steps included, so what the
   * batches already reported is subtracted rather than reported twice. The step
   * rows are then skipped outright: a row that lands after the prompt finished
   * used to be read as the next turn's work, which is how a prompt's usage was
   * reported twice.
   */
  settlePromptTurnFromAcp(
    account: AccountDescriptor,
    nativeSessionId: string,
    usage: TokenUsageSummary,
  ): TokenUsageSummary {
    const settled = subtractUsage(usage, this.turnReported);
    this.turnReported = emptyUsage();
    const steps = this.stepCountInPrompt;
    this.stepCountInPrompt = 1;
    const landed = this.skipUnseenSteps(account, nativeSessionId);
    this.absorbedPending = Math.min(
      MAX_ABSORBED_PENDING,
      this.absorbedPending + Math.max(0, steps - landed),
    );
    return settled;
  }

  /**
   * Moves the cursor past `agy`'s rows without reporting them, and says how many
   * rows that covered: the prompt result paid for the steps whose rows are still
   * on their way as well, and those are counted in `absorbedPending`.
   */
  private skipUnseenSteps(
    account: AccountDescriptor,
    nativeSessionId: string,
  ): number {
    if (!nativeSessionId) return 0;
    const steps = readConversationStepUsages(account, nativeSessionId);
    const unseen = steps.filter((s) => s.idx > this.lastReportedStepIdx);
    if (unseen.length === 0) return 0;
    this.lastReportedStepIdx = unseen[unseen.length - 1]!.idx;
    return unseen.length;
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
    this.turnReported = emptyUsage();
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
      this.turnReported = emptyUsage();
      this.bankUnreported(settled);
    } catch {}
  }
}
