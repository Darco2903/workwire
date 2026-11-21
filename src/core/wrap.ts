import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { deserializeError, serializeError, WorkerClosedError } from './errors.ts';
import {
  isMessage,
  isRequest,
  message,
  type AbortMessage,
  type Body,
  type CallMessage,
  type NextMessage,
  type ReturnMessage,
} from './protocol.ts';
import { isAbortSignal } from './signal.ts';
import { collectTransfers } from './transfer.ts';
import { release, type Remote } from './types.ts';

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  signals: readonly AbortSignal[];
}

const STREAM = Symbol('workerHelper.stream');
type RemoteIterator = AsyncIterableIterator<unknown> & { [STREAM]: true };

/**
 * A call's result is a regular Promise that is also async-iterable, so
 * streaming methods can be used directly with `for await`.
 * @internal
 */
export function callResult(promise: Promise<unknown>, method: string): Promise<unknown> & AsyncIterable<unknown> {
  return Object.assign(promise, {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const stream = promise.then((value) => {
        if ((value as RemoteIterator | undefined)?.[STREAM]) return value as RemoteIterator;
        throw new TypeError(`${method}() did not return an async iterable`);
      });
      return {
        next: () => stream.then((it) => it.next()),
        return: () => stream.then((it) => it.return!(), () => ({ value: undefined, done: true })),
      };
    },
  });
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
    if (!isMessage(data) || isRequest(data)) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    switch (data.type) {
      case 'result':
        return entry.resolve(data.value);
      case 'stream':
        return entry.resolve(createStream(data.id, entry.signals));
      case 'yield':
        return entry.resolve({ value: data.value, done: data.done });
      case 'error':
        return entry.reject(deserializeError(data.error));
    }
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

  function post(body: Body<CallMessage | NextMessage | ReturnMessage | AbortMessage>, transfers: object[] = []): void {
    endpoint.post(message(body as Body<CallMessage>), transfers);
  }

  /** Send a request and wait for the reply with the same id. */
  function request(
    id: number,
    body: Body<CallMessage | NextMessage | ReturnMessage>,
    signals: readonly AbortSignal[] = [],
    transfers: object[] = [],
  ): Promise<unknown> {
    if (closedReason) return Promise.reject(closedReason);
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => (pending.delete(id), resolve(value)),
        reject: (reason) => (pending.delete(id), reject(reason)),
        signals,
      });
      try {
        post(body, transfers);
      } catch (error) {
        // e.g. DataCloneError for a non-cloneable argument
        pending.get(id)?.reject(error);
      }
    });
  }

  function sendAbort(id: number, reason: unknown): void {
    if (closedReason) return;
    try {
      post({ type: 'abort', id, reason: serializeError(reason) });
    } catch {
      // The reason was not cloneable: still abort, with a generic reason.
      post({ type: 'abort', id, reason: serializeError(new Error('Aborted')) });
    }
  }

  /** Call `onAbort` once when any of `signals` aborts. Returns a cleanup function. */
  function watch(signals: readonly AbortSignal[], onAbort: (reason: unknown) => void): () => void {
    const listener = (event: Event) => onAbort((event.target as AbortSignal).reason);
    for (const signal of signals) signal.addEventListener('abort', listener, { once: true });
    return () => {
      for (const signal of signals) signal.removeEventListener('abort', listener);
    };
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
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
    const body: Body<CallMessage> = { type: 'call', id, method, args: sent };
    if (indexes.length) body.signals = indexes;
    const reply = request(id, body, signals, collectTransfers(args));
    if (!signals.length) return reply;

    return new Promise((resolve, reject) => {
      const unwatch = watch(signals, (reason) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(reason);
        sendAbort(id, reason);
      });
      reply.then(resolve, reject).finally(unwatch);
    });
  }

  function createStream(id: number, signals: readonly AbortSignal[]): RemoteIterator {
    let done = false;
    let failure: { reason: unknown } | undefined;
    let queue: Promise<unknown> = Promise.resolve();

    const end = () => {
      done = true;
      unwatch();
    };
    const unwatch = watch(signals, (reason) => {
      if (done) return;
      failure = { reason };
      end();
      pending.get(id)?.reject(reason);
      sendAbort(id, reason);
    });

    // Serialise next()/return() so at most one pull is in flight per stream.
    const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
      const result = queue.then(task);
      queue = result.catch(() => {});
      return result;
    };

    const finished = (): IteratorResult<unknown> => ({ value: undefined, done: true });

    return {
      [STREAM]: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return enqueue(async () => {
          if (failure) throw failure.reason;
          if (done) return finished();
          try {
            const result = (await request(id, { type: 'next', id })) as IteratorResult<unknown>;
            if (result.done) end();
            return result;
          } catch (reason) {
            end();
            throw reason;
          }
        });
      },
      return() {
        return enqueue(async () => {
          if (done) return finished();
          end();
          await request(id, { type: 'return', id });
          return finished();
        });
      },
    };
  }

  const methods = new Map<string, (...args: unknown[]) => unknown>();

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
        fn = (...args) => callResult(call(prop, args), prop);
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}
