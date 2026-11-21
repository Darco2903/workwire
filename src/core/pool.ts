import type { MessageTarget } from './endpoint.ts';
import { WorkerClosedError } from './errors.ts';
import { release, type Remote } from './types.ts';
import { callResult, wrap } from './wrap.ts';

export interface PoolOptions {
  /** Maximum number of workers. Defaults to `navigator.hardwareConcurrency` (or 4). */
  size?: number;
}

interface Slot {
  remote: Remote<unknown>;
  busy: number;
}

function defaultSize(): number {
  const navigator = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  return navigator?.hardwareConcurrency || 4;
}

/**
 * Spread calls over up to `size` workers created by `factory`.
 *
 * Returns the same `Remote<T>` as `wrap`, so it is a drop-in replacement.
 * - Workers are created lazily, only when every existing one is busy.
 * - Each call goes to the worker with the fewest calls in flight. A stream
 *   counts as in flight until its first reply, then stays on its worker.
 * - A worker that dies is replaced on the next call (its pending calls still
 *   reject with `WorkerClosedError`; calls are never retried).
 * - `pool[release]()` terminates every worker.
 *
 * @example
 * const pool = createPool<MathApi>(() => new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));
 */
export function createPool<T>(factory: () => MessageTarget, options: PoolOptions = {}): Remote<T> {
  const size = Math.max(1, Math.floor(options.size ?? defaultSize()));
  const slots: Slot[] = [];
  let released = false;

  function pick(): Slot {
    let best: Slot | undefined;
    for (const slot of slots) if (!best || slot.busy < best.busy) best = slot;
    if ((!best || best.busy > 0) && slots.length < size) {
      best = { remote: wrap<unknown>(factory()), busy: 0 };
      slots.push(best);
    }
    return best!;
  }

  function drop(slot: Slot): void {
    const index = slots.indexOf(slot);
    if (index === -1) return;
    slots.splice(index, 1);
    slot.remote[release]();
  }

  function invoke(method: string, args: unknown[]): Promise<unknown> {
    if (released) return callResult(Promise.reject(new WorkerClosedError('Pool was released')), method);
    const slot = pick();
    slot.busy++;
    const result = (slot.remote as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    result.then(
      () => slot.busy--,
      (error: unknown) => {
        slot.busy--;
        if (error instanceof WorkerClosedError && !released) drop(slot);
      },
    );
    return result;
  }

  const methods = new Map<string, (...args: unknown[]) => unknown>();

  return new Proxy({} as Remote<T>, {
    get(_, prop) {
      if (prop === release) {
        return () => {
          released = true;
          for (const slot of slots.splice(0)) slot.remote[release]();
        };
      }
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      let fn = methods.get(prop);
      if (!fn) {
        fn = (...args) => invoke(prop, args);
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}
