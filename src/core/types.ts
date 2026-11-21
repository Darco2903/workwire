export type AnyFunction = (...args: any[]) => any;

/**
 * Constraint for a worker contract: every property must be a function.
 * Written as a mapped type (not `Record<string, AnyFunction>`) so that
 * `interface` contracts are accepted too.
 */
export type Contract<T> = { [K in keyof T]: AnyFunction };

/** Calling side symbol that releases the remote (and terminates the worker). */
export const release: unique symbol = Symbol.for('workerHelper.release');

/** Promise-returning version of one contract method. */
export type RemoteMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** Caller-side view of a contract `T`: every method returns a Promise. */
export type Remote<T> = {
  readonly [K in keyof T as K extends string ? K : never]: RemoteMethod<T[K]>;
} & {
  /** Reject pending calls, stop listening and terminate the worker / close the port. */
  [release](): void;
};
