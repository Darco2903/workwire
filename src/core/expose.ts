import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { deserializeError, serializeError } from './errors.ts';
import { isMessage, message, type CallMessage, type ErrorMessage, type ResultMessage } from './protocol.ts';
import { collectTransfers } from './transfer.ts';
import type { Contract } from './types.ts';

function lookup(api: object, method: string): Function {
  // Reject inherited Object.prototype members such as `constructor` or `toString`.
  const fn = Object.hasOwn(Object.prototype, method) ? undefined : (api as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new TypeError(`Unknown method "${method}"`);
  return fn;
}

/**
 * Serve `api` over `target`. Returns a function that stops serving.
 *
 * The platform entries (`@darco2903/worker-helper`) provide `expose()` with a
 * default target (`self` / `parentPort`).
 */
export function exposeOn<T extends Contract<T>>(api: T, target: MessageTarget): () => void {
  const endpoint = toEndpoint(target);
  const controllers = new Map<number, AbortController>();

  function post(reply: ResultMessage | ErrorMessage, transfers: object[]): void {
    try {
      endpoint.post(reply, transfers);
    } catch (thrown) {
      // Typically a DataCloneError: the result (or a thrown value) is not
      // structured-cloneable. Report it instead of leaving the caller hanging.
      endpoint.post(message<ErrorMessage>({ type: 'error', id: reply.id, error: serializeError(asError(thrown)) }), []);
    }
  }

  async function handle(call: CallMessage): Promise<void> {
    const { id, args } = call;
    let controller: AbortController | undefined;
    if (call.signals?.length) {
      controller = new AbortController();
      controllers.set(id, controller);
      for (const index of call.signals) args[index] = controller.signal;
    }
    try {
      const value = await lookup(api, call.method).apply(api, args);
      if (controller?.signal.aborted) return; // the caller already gave up
      post(message<ResultMessage>({ type: 'result', id, value }), collectTransfers([value]));
    } catch (thrown) {
      if (controller?.signal.aborted) return;
      post(message<ErrorMessage>({ type: 'error', id, error: serializeError(thrown) }), []);
    } finally {
      controllers.delete(id);
    }
  }

  return endpoint.listen((data) => {
    if (!isMessage(data)) return;
    if (data.type === 'call') void handle(data);
    else if (data.type === 'abort') controllers.get(data.id)?.abort(deserializeError(data.reason));
  });
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
