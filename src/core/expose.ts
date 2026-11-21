import { toEndpoint, type MessageTarget } from './endpoint.ts';
import { serializeError } from './errors.ts';
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
 * The platform entries (`@darco2903/worker-helper`) provide an overload with a
 * default target (`self` / `parentPort`).
 */
export function exposeOn<T extends Contract<T>>(api: T, target: MessageTarget): () => void {
  const endpoint = toEndpoint(target);

  async function handle(call: CallMessage): Promise<void> {
    const { id } = call;
    let reply: ResultMessage | ErrorMessage;
    let transfers: object[] = [];
    try {
      const value = await lookup(api, call.method).apply(api, call.args);
      reply = message<ResultMessage>({ type: 'result', id, value });
      transfers = collectTransfers([value]);
    } catch (thrown) {
      reply = message<ErrorMessage>({ type: 'error', id, error: serializeError(thrown) });
    }
    try {
      endpoint.post(reply, transfers);
    } catch (thrown) {
      // Typically a DataCloneError: the result (or a thrown value) is not
      // structured-cloneable. Report it instead of leaving the caller hanging.
      endpoint.post(message<ErrorMessage>({ type: 'error', id, error: serializeError(asError(thrown)) }), []);
    }
  }

  return endpoint.listen((data) => {
    if (isMessage(data) && data.type === 'call') void handle(data);
  });
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
