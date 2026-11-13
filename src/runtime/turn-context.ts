import { BridgeHttpError, type TurnStreamEvent } from "../types";

/**
 * The per-turn event plumbing of a session worker, in one place.
 *
 * A worker's turn used to be tracked by half a dozen loose fields spread across
 * `AgySessionWorker`: an epoch counter, a "suppress the steer cancel" flag, the
 * active event queue, the thinking accumulator, the held text (the tail of a
 * stream that might be the agent's error marker) and the in-flight
 * `session/prompt` promise. Every state transition had to touch them in the
 * right order from several callbacks, so a stale prompt callback could clear the
 * queue of the turn that replaced it.
 *
 * `TurnContext` owns exactly those six things and nothing else: it never talks
 * to ACP, never touches the broker, and never decides worker state. Callers get
 * atomic operations (`beginTurnQueue`, `finishWith`, `nextPromptEpoch`) instead
 * of field writes.
 */

/** 16 MiB is far above any legitimate single-turn event burst for this bridge. */
export const DEFAULT_MAX_TURN_QUEUE_BYTES = 16 * 1024 * 1024;

const DEFAULT_EVENT_OVERHEAD_BYTES = 128;

function defaultEstimateEventBytes(item: any): number {
  switch (item?.type) {
    case "text_delta":
      return 64 + Buffer.byteLength(String(item.text ?? ""));
    case "thinking_delta":
      return 64 + Buffer.byteLength(String(item.thinking ?? ""));
    case "thinking_signature":
      return 64 + Buffer.byteLength(String(item.signature ?? ""));
    case "tool_use": {
      let json = "{}";
      try {
        json = JSON.stringify(item.input ?? {});
      } catch {
        json = "{}";
      }
      return 128 + Buffer.byteLength(json);
    }
    default:
      return DEFAULT_EVENT_OVERHEAD_BYTES;
  }
}

export interface AsyncEventQueueOptions<T> {
  /** Buffered-byte ceiling for undelivered items. Default 16 MiB. */
  maxBufferedBytes?: number;
  estimateBytes?: (item: T) => number;
  /** Called once after the queue overflows and closes itself with an error. */
  onOverflow?: (err: BridgeHttpError) => void;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private bufferedBytes = 0;
  private waiters: Array<{
    resolve: (item: IteratorResult<T>) => void;
    reject: (err: any) => void;
  }> = [];
  private closed = false;
  private error: any = null;
  private readonly maxBufferedBytes: number;
  private readonly estimateBytes: (item: T) => number;
  private readonly onOverflow?: (err: BridgeHttpError) => void;

  constructor(options?: AsyncEventQueueOptions<T>) {
    this.maxBufferedBytes =
      options?.maxBufferedBytes ?? DEFAULT_MAX_TURN_QUEUE_BYTES;
    this.estimateBytes =
      options?.estimateBytes ??
      (defaultEstimateEventBytes as (item: T) => number);
    this.onOverflow = options?.onOverflow;
  }

  /** Bytes currently buffered (items already handed to a waiter are not). */
  get pendingBytes(): number {
    return this.bufferedBytes;
  }

  private measure(item: T): number {
    try {
      const bytes = this.estimateBytes(item);
      return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    } catch {
      return 0;
    }
  }

  push(item: T): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: item, done: false });
      return;
    }

    const itemBytes = this.measure(item);
    if (this.bufferedBytes + itemBytes > this.maxBufferedBytes) {
      // A consumer that stopped reading must not let ACP stdout grow this queue
      // without bound. Drop what is buffered and fail the turn instead.
      this.queue = [];
      this.bufferedBytes = 0;
      const err = new BridgeHttpError(
        502,
        "api_error",
        "Agent stream buffer exceeded maximum capacity due to slow consumer",
      );
      this.errorAndClose(err);
      try {
        this.onOverflow?.(err);
      } catch {}
      return;
    }

    this.queue.push(item);
    this.bufferedBytes += itemBytes;
  }

  errorAndClose(err: any): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    this.queue = [];
    this.bufferedBytes = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined as any, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift()!;
      this.bufferedBytes = Math.max(0, this.bufferedBytes - this.measure(value));
      return { value, done: false };
    }
    if (this.closed) {
      if (this.error) {
        throw this.error;
      }
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

export interface BeginTurnQueueOptions {
  maxBufferedBytes?: number;
  onOverflow: () => void;
}

/**
 * One worker's per-turn state: the epoch that tells a stale `session/prompt`
 * callback from the live one, the active event queue, and the text the model
 * has produced but not yet handed over.
 */
export class TurnContext {
  private promptSeq = 0;
  private activePromptSeq = 0;
  private steerCancelSuppressed = false;
  private quietQueue: AsyncEventQueue<TurnStreamEvent> | null = null;
  private thinking = "";
  private held = "";
  private prompt: Promise<any> | null = null;

  /** The epoch of the prompt whose events belong to the current turn. */
  get promptEpoch(): number {
    return this.activePromptSeq;
  }

  /**
   * While true, `session/update` text is dropped and prompt callbacks only bank
   * usage: the turn was cancelled to steer and its remaining output is not the
   * caller's.
   */
  get suppressingSteerCancel(): boolean {
    return this.steerCancelSuppressed;
  }

  set suppressingSteerCancel(value: boolean) {
    this.steerCancelSuppressed = Boolean(value);
  }

  /** The queue of the turn in flight, if any. */
  get activeQueue(): AsyncEventQueue<TurnStreamEvent> | null {
    return this.quietQueue;
  }

  get queueOpen(): boolean {
    return this.quietQueue !== null;
  }

  /** Text held back because it may be (or end with) the agent's error marker. */
  get heldText(): string {
    return this.held;
  }

  set heldText(value: string) {
    this.held = value;
  }

  get thinkingText(): string {
    return this.thinking;
  }

  set thinkingText(value: string) {
    this.thinking = value;
  }

  get pendingPrompt(): Promise<any> | null {
    return this.prompt;
  }

  set pendingPrompt(promise: Promise<any> | null) {
    this.prompt = promise;
  }

  /** Clears the accumulated thought (a new turn, or thinking turned off). */
  resetThinking(): void {
    this.thinking = "";
  }

  /**
   * Starts a turn: the held text and the accumulated thought belong to the
   * previous one, so they are dropped with it.
   */
  beginTurnQueue(options: BeginTurnQueueOptions): AsyncEventQueue<TurnStreamEvent> {
    this.thinking = "";
    this.held = "";
    const queue = new AsyncEventQueue<TurnStreamEvent>({
      maxBufferedBytes: options.maxBufferedBytes,
      onOverflow: options.onOverflow,
    });
    this.quietQueue = queue;
    return queue;
  }

  /**
   * Takes the queue out of the context without closing it. The caller owns it
   * from here (a batch hand-off, which settles the turn from another task).
   */
  takeQueue(): AsyncEventQueue<TurnStreamEvent> | null {
    const queue = this.quietQueue;
    this.quietQueue = null;
    return queue;
  }

  /** The next prompt's epoch; callbacks carrying an older one are stale. */
  nextPromptEpoch(): number {
    const seq = ++this.promptSeq;
    this.activePromptSeq = seq;
    return seq;
  }

  /** True when this callback belongs to a cancelled or superseded prompt. */
  isSuppressedOrStale(seq?: number): boolean {
    return (
      this.steerCancelSuppressed ||
      (seq !== undefined && seq !== this.activePromptSeq)
    );
  }

  pushEvent(event: TurnStreamEvent): void {
    this.quietQueue?.push(event);
  }

  /**
   * Appends a thought delta to the accumulator and forwards it, so the block a
   * `thinking_signature` closes is exactly what was streamed.
   */
  appendThinking(delta: string): void {
    this.thinking += delta;
    this.quietQueue?.push({ type: "thinking_delta", thinking: delta });
  }

  /** The accumulated thought, cleared: the bytes the next signature covers. */
  consumeThinkingForSignature(): string {
    const thinking = this.thinking;
    this.thinking = "";
    return thinking;
  }

  /**
   * Pushes the turn's final event, then closes its queue.
   *
   * The queue is cleared *before* the push because `push()` can overflow it: an
   * overflow error-and-closes the queue and schedules worker teardown, so a
   * later read of `activeQueue` could observe `null` — or worse, a queue the
   * caller then closes twice.
   */
  finishWith(event: TurnStreamEvent): void {
    const queue = this.quietQueue;
    if (!queue) return;
    this.quietQueue = null;
    queue.push(event);
    queue.close();
  }

  /** Closes the turn's queue without a final event. */
  closeQueue(): void {
    const queue = this.quietQueue;
    if (!queue) return;
    this.quietQueue = null;
    queue.close();
  }

  /** Fails the turn's queue so its consumer sees `err`. */
  failQueue(err: unknown): void {
    const queue = this.quietQueue;
    if (!queue) return;
    this.quietQueue = null;
    queue.errorAndClose(err);
  }
}
