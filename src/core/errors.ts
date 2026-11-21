/** Wire format for a thrown value. */
export type SerializedError =
  | {
      kind: 'error';
      name: string;
      message: string;
      stack?: string;
      cause?: SerializedError;
      /** Own enumerable primitive properties, e.g. Node's `code` / `errno`. */
      props?: Record<string, string | number | boolean | null>;
    }
  | { kind: 'value'; value: unknown };

/** Error rebuilt on the caller's side from an error thrown in the other thread. */
export class RemoteError extends Error {
  /** Stack trace from the thread that threw. */
  readonly remoteStack: string | undefined;
  [key: string]: unknown;

  constructor(name: string, message: string, remoteStack?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = name;
    this.remoteStack = remoteStack;
    if (remoteStack && this.stack) {
      const localFrames = this.stack.split('\n').slice(1).join('\n');
      this.stack = `${remoteStack}\n    --- worker boundary ---\n${localFrames}`;
    }
  }
}

/** Thrown when calling a released remote, or into a worker that died. */
export class WorkerClosedError extends Error {
  override name = 'WorkerClosedError';
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function serializeError(thrown: unknown, depth = 0): SerializedError {
  if (!(thrown instanceof Error)) {
    // Non-Error values (strings, plain objects, ...) are sent as-is and
    // rethrown as-is, matching plain JS semantics.
    return { kind: 'value', value: thrown };
  }
  const out: Extract<SerializedError, { kind: 'error' }> = {
    kind: 'error',
    name: thrown.name,
    message: thrown.message,
  };
  if (thrown.stack !== undefined) out.stack = thrown.stack;
  if (thrown.cause !== undefined && depth < 8) out.cause = serializeError(thrown.cause, depth + 1);
  for (const [key, value] of Object.entries(thrown)) {
    if (key === 'cause' || !isPrimitive(value)) continue;
    (out.props ??= {})[key] = value;
  }
  return out;
}

export function deserializeError(error: SerializedError): unknown {
  if (error.kind === 'value') return error.value;
  const options = error.cause ? { cause: deserializeError(error.cause) } : undefined;
  const result = new RemoteError(error.name, error.message, error.stack, options);
  if (error.props) Object.assign(result, error.props);
  return result;
}
