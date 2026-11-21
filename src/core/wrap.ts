import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { deserializeError, WorkerClosedError } from './errors.ts';
import { isMessage, message, type CallMessage } from './protocol.ts';
import { collectTransfers } from './transfer.ts';
import { release, type Remote } from './types.ts';

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/**
 * Create a typed proxy for the API exposed on the other side of `target`.
 *
 * @example
 * const math = wrap<MathApi>(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));
 * await math.add(1, 2); // Promise<number>
 */
export function wrap<T>(target: MessageTarget): Remote<T> {
  const endpoint = toEndpoint(target);
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let closedReason: Error | undefined;

  const unlisten = endpoint.listen((data) => {
    if (!isMessage(data) || data.type === 'call') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === 'result') entry.resolve(data.value);
    else entry.reject(deserializeError(data.error));
  });

  const unfatal = endpoint.onFatal?.((error) => shutdown(new WorkerClosedError(error.message, { cause: error })));

  function shutdown(reason: Error): void {
    if (closedReason) return;
    closedReason = reason;
    unlisten();
    unfatal?.();
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
    if (closedReason) return Promise.reject(closedReason);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        endpoint.post(message<CallMessage>({ type: 'call', id, method, args }), collectTransfers(args));
      } catch (error) {
        // e.g. DataCloneError for a non-cloneable argument
        pending.delete(id);
        reject(error);
      }
    });
  }

  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  return new Proxy({} as Remote<T>, {
    get(_, prop) {
      if (prop === release) {
        return () => {
          shutdown(new WorkerClosedError('Remote was released'));
          endpoint.close?.();
        };
      }
      // Symbols and `then` must stay undefined so the proxy is not mistaken
      // for a thenable (e.g. when returned from an async function).
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      let fn = methods.get(prop);
      if (!fn) {
        fn = (...args) => call(prop, args);
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}
