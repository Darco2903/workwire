import type { Transferable } from './endpoint.ts';

const marks = new WeakMap<object, readonly Transferable[]>();

/**
 * Mark `value` so that `transferables` are moved to the other thread instead of
 * copied. Works on call arguments and on return values.
 *
 * @example
 * await remote.process(transfer(pixels, [pixels.buffer]));
 */
export function transfer<T extends object>(value: T, transferables: readonly Transferable[]): T {
  marks.set(value, transferables);
  return value;
}

/** Collect the transfer list for a set of top-level values. */
export function collectTransfers(values: readonly unknown[]): Transferable[] {
  const out: Transferable[] = [];
  for (const value of values) {
    if (typeof value === 'object' && value !== null) {
      const list = marks.get(value);
      if (list) out.push(...list);
    }
  }
  return out;
}
