import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { deserializeError, serializeError } from './errors.ts';
import {
  isMessage,
  isRequest,
  message,
  type CallMessage,
  type ErrorMessage,
  type ReplyMessage,
  type ResultMessage,
  type StreamMessage,
  type YieldMessage,
} from './protocol.ts';
import { collectTransfers } from './transfer.ts';
import type { Contract } from './types.ts';

function lookup(api: object, method: string): Function {
  // Reject inherited Object.prototype members such as `constructor` or `toString`.
  const fn = Object.hasOwn(Object.prototype, method) ? undefined : (api as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new TypeError(`Unknown method "${method}"`);
  return fn;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * Serve `api` over `target`. Returns a function that stops serving.
 *
 * The platform entries (`@darco2903/workwire`) provide `expose()` with a
 * default target (`self` / `parentPort`).
 */
export function exposeOn<T extends Contract<T>>(api: T, target: MessageTarget): () => void {
  const endpoint = toEndpoint(target);
  /** Per-call AbortControllers, alive until the call (or its stream) ends. */
  const controllers = new Map<number, AbortController>();
  /** Open streams, by call id. */
  const streams = new Map<number, AsyncIterator<unknown>>();

  function post(reply: ReplyMessage, transfers: object[] = []): void {
    try {
      endpoint.post(reply, transfers);
    } catch (thrown) {
      // Typically a DataCloneError: the value is not structured-cloneable.
      // Report it instead of leaving the caller hanging.
      endpoint.post(message<ErrorMessage>({ type: 'error', id: reply.id, error: serializeError(asError(thrown)) }), []);
    }
  }

  function postError(id: number, thrown: unknown): void {
    post(message<ErrorMessage>({ type: 'error', id, error: serializeError(thrown) }));
  }

  function finish(id: number): void {
    streams.delete(id);
    controllers.delete(id);
  }

  async function call(request: CallMessage): Promise<void> {
    const { id, args } = request;
    let controller: AbortController | undefined;
    if (request.signals?.length) {
      controller = new AbortController();
      controllers.set(id, controller);
      for (const index of request.signals) args[index] = controller.signal;
    }
    try {
      const value = await lookup(api, request.method).apply(api, args);
      if (controller?.signal.aborted) return finish(id); // the caller already gave up
      const transfers = collectTransfers([value]);
      // Async iterables are streamed, unless explicitly marked for transfer
      // (e.g. `transfer(readable, [readable])`).
      if (isAsyncIterable(value) && transfers.length === 0) {
        streams.set(id, value[Symbol.asyncIterator]());
        post(message<StreamMessage>({ type: 'stream', id }));
        return;
      }
      finish(id);
      post(message<ResultMessage>({ type: 'result', id, value }), transfers);
    } catch (thrown) {
      const aborted = controller?.signal.aborted;
      finish(id);
      if (!aborted) postError(id, thrown);
    }
  }

  async function next(id: number): Promise<void> {
    const iterator = streams.get(id);
    if (!iterator) return postError(id, new Error('Stream is closed'));
    try {
      const result = await iterator.next();
      if (streams.get(id) !== iterator) return; // aborted or returned meanwhile
      if (result.done) finish(id);
      post(
        message<YieldMessage>({ type: 'yield', id, value: result.value, done: Boolean(result.done) }),
        collectTransfers([result.value]),
      );
    } catch (thrown) {
      if (streams.get(id) !== iterator) return;
      finish(id);
      postError(id, thrown);
    }
  }

  async function stop(id: number, reply: boolean): Promise<void> {
    const iterator = streams.get(id);
    finish(id);
    try {
      await iterator?.return?.();
      if (reply) post(message<YieldMessage>({ type: 'yield', id, value: undefined, done: true }));
    } catch (thrown) {
      if (reply) postError(id, thrown);
    }
  }

  return endpoint.listen((data) => {
    if (!isMessage(data) || !isRequest(data)) return;
    switch (data.type) {
      case 'call':
        return void call(data);
      case 'next':
        return void next(data.id);
      case 'return':
        return void stop(data.id, true);
      case 'abort':
        controllers.get(data.id)?.abort(deserializeError(data.reason));
        // Close an open stream so the generator's `finally` blocks run.
        if (streams.has(data.id)) void stop(data.id, false);
    }
  });
}
