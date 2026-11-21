import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { deserializeError, serializeError, WorkerClosedError } from './errors.ts';
import { isMessage, message, TAG, type AbortMessage, type CallMessage } from './protocol.ts';
import { isAbortSignal } from './signal.ts';
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
    if (!isMessage(data) || data.type === 'call' || data.type === 'abort') return;
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

    // AbortSignals cannot be cloned: send their positions, the other side
    // substitutes a signal of its own and we forward the abort.
    const signals: AbortSignal[] = [];
    const indexes: number[] = [];
    const sent = args.map((arg, index) => {
      if (!isAbortSignal(arg)) return arg;
      signals.push(arg);
      indexes.push(index);
      return null;
    });
    const alreadyAborted = signals.find((signal) => signal.aborted);
    if (alreadyAborted) return Promise.reject(alreadyAborted.reason);

    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (event: Event) => {
        if (!pending.has(id)) return;
        const { reason } = event.target as AbortSignal;
        settle();
        reject(reason);
        sendAbort(id, reason);
      };
      const settle = () => {
        pending.delete(id);
        for (const signal of signals) signal.removeEventListener('abort', onAbort);
      };
      for (const signal of signals) signal.addEventListener('abort', onAbort);
      pending.set(id, {
        resolve: (value) => (settle(), resolve(value)),
        reject: (reason) => (settle(), reject(reason)),
      });

      const body: Omit<CallMessage, typeof TAG> = { type: 'call', id, method, args: sent };
      if (indexes.length) body.signals = indexes;
      try {
        endpoint.post(message<CallMessage>(body), collectTransfers(args));
      } catch (error) {
        // e.g. DataCloneError for a non-cloneable argument
        pending.get(id)?.reject(error);
      }
    });
  }

  function sendAbort(id: number, reason: unknown): void {
    if (closedReason) return;
    try {
      endpoint.post(message<AbortMessage>({ type: 'abort', id, reason: serializeError(reason) }), []);
    } catch {
      // The reason was not cloneable: still abort, with a generic reason.
      endpoint.post(message<AbortMessage>({ type: 'abort', id, reason: serializeError(new Error('Aborted')) }), []);
    }
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
