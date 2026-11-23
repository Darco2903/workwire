import type { MessageTarget } from './endpoint.ts';
import { WorkerClosedError } from './errors.ts';
import { isAbortSignal, watchSignals } from './signal.ts';
import { release, type Remote } from './types.ts';
import { callResult, isRemoteIterator, STREAM, wrap, type RemoteIterator } from './wrap.ts';

export interface PoolOptions {
  /** Maximum number of workers. Defaults to `navigator.hardwareConcurrency` (or 4). */
  size?: number;
  /** Maximum number of calls running at once on each worker. Defaults to 1. */
  concurrency?: number;
}

interface Slot {
  remote: Remote<unknown>;
  busy: number;
}

interface Task {
  method: string;
  args: unknown[];
  signals: AbortSignal[];
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  /** Stops watching `signals` while the task is queued. */
  unwatch(): void;
}

type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;

function defaultSize(): number {
  const navigator = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  return navigator?.hardwareConcurrency || 4;
}

function positiveInt(value: number): number {
  return Math.max(1, Math.floor(value));
}

/**
 * Spread calls over up to `size` workers created by `factory`.
 *
 * Returns the same `Remote<T>` as `wrap`, so it is a drop-in replacement.
 * - Each worker runs at most `concurrency` calls at once. Further calls wait
 *   in a FIFO queue and start on the first worker that frees up.
 * - Workers are created lazily, only when no existing one has room.
 * - A stream occupies its worker until it ends, fails, is closed (`break`) or
 *   aborted.
 * - Aborting a queued call removes it from the queue; it never reaches a worker.
 * - A worker that dies is replaced. Its in-flight calls reject with
 *   `WorkerClosedError` (calls are never retried); queued calls are unaffected.
 * - `pool[release]()` rejects queued calls and terminates every worker.
 *
 * @example
 * const pool = createPool<MathApi>(() => new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));
 */
export function createPool<T>(factory: () => MessageTarget, options: PoolOptions = {}): Remote<T> {
  const size = positiveInt(options.size ?? defaultSize());
  const concurrency = positiveInt(options.concurrency ?? 1);
  const slots: Slot[] = [];
  const queue: Task[] = [];
  let released = false;

  /** The least busy worker with room, a new worker, or `undefined` if the pool is full. */
  function acquire(): Slot | undefined {
    let best: Slot | undefined;
    for (const slot of slots) if (slot.busy < concurrency && (!best || slot.busy < best.busy)) best = slot;
    if (!best && slots.length < size) {
      best = { remote: wrap<unknown>(factory()), busy: 0 };
      slots.push(best);
    }
    return best;
  }

  function drop(slot: Slot): void {
    const index = slots.indexOf(slot);
    if (index === -1) return;
    slots.splice(index, 1);
    slot.remote[release]();
  }

  /** Start queued tasks while workers have room. */
  function pump(): void {
    while (!released && queue.length) {
      const slot = acquire();
      if (!slot) return;
      const task = queue.shift()!;
      task.unwatch();
      run(slot, task);
    }
  }

  function run(slot: Slot, task: Task): void {
    slot.busy++;
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      if (error instanceof WorkerClosedError && !released) drop(slot);
      slot.busy--;
      pump();
    };

    (slot.remote as unknown as Methods)[task.method]!(...task.args).then(
      (value) => {
        if (isRemoteIterator(value)) return task.resolve(holdStream(value, task.signals, finish));
        finish();
        task.resolve(value);
      },
      (error: unknown) => {
        finish(error);
        task.reject(error);
      },
    );
  }

  /** Wrap a stream so its worker stays occupied until the stream is over. */
  function holdStream(
    inner: RemoteIterator,
    signals: readonly AbortSignal[],
    finish: (error?: unknown) => void,
  ): RemoteIterator {
    const unwatch = watchSignals(signals, () => end());
    const end = (error?: unknown) => {
      unwatch();
      finish(error);
    };
    return {
      [STREAM]: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        try {
          const result = await inner.next();
          if (result.done) end();
          return result;
        } catch (error) {
          end(error);
          throw error;
        }
      },
      async return() {
        try {
          const result = await inner.return!();
          end();
          return result;
        } catch (error) {
          end(error);
          throw error;
        }
      },
    };
  }

  function invoke(method: string, args: unknown[]): Promise<unknown> {
    if (released) return Promise.reject(new WorkerClosedError('Pool was released'));
    const signals = args.filter(isAbortSignal);
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) return Promise.reject(aborted.reason);

    return new Promise((resolve, reject) => {
      const task: Task = { method, args, signals, resolve, reject, unwatch: () => {} };
      const slot = acquire();
      if (slot) return run(slot, task);
      queue.push(task);
      task.unwatch = watchSignals(signals, (reason) => {
        const index = queue.indexOf(task);
        if (index === -1) return;
        queue.splice(index, 1);
        task.unwatch();
        reject(reason);
      });
    });
  }

  const methods = new Map<string, (...args: unknown[]) => unknown>();

  return new Proxy({} as Remote<T>, {
    get(_, prop) {
      if (prop === release) {
        return () => {
          released = true;
          const reason = new WorkerClosedError('Pool was released');
          for (const task of queue.splice(0)) {
            task.unwatch();
            task.reject(reason);
          }
          for (const slot of slots.splice(0)) slot.remote[release]();
        };
      }
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      let fn = methods.get(prop);
      if (!fn) {
        fn = (...args) => callResult(invoke(prop, args), prop);
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}
