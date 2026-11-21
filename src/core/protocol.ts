import type { SerializedError } from './errors.ts';

/** Marker so unrelated messages on a shared channel are ignored. */
export const TAG = '__workwire';

interface Base {
  [TAG]: 1;
  id: number;
}

export interface CallMessage extends Base {
  type: 'call';
  method: string;
  args: unknown[];
  /** Indexes of arguments that were AbortSignals (sent as `null`). */
  signals?: number[];
}

export interface AbortMessage extends Base {
  type: 'abort';
  reason: SerializedError;
}

export interface ResultMessage extends Base {
  type: 'result';
  value: unknown;
}

export interface ErrorMessage extends Base {
  type: 'error';
  error: SerializedError;
}

/** Caller asks for the next value of a stream. */
export interface NextMessage extends Base {
  type: 'next';
}

/** Caller stops a stream early (`break` in `for await`). */
export interface ReturnMessage extends Base {
  type: 'return';
}

/** The call returned an async iterable: values will be pulled with `next`. */
export interface StreamMessage extends Base {
  type: 'stream';
}

export interface YieldMessage extends Base {
  type: 'yield';
  value: unknown;
  done: boolean;
}

/** Messages sent by the calling side. */
export type RequestMessage = CallMessage | AbortMessage | NextMessage | ReturnMessage;
/** Messages sent by the exposing side. */
export type ReplyMessage = ResultMessage | ErrorMessage | StreamMessage | YieldMessage;
export type Message = RequestMessage | ReplyMessage;

const REQUESTS: ReadonlySet<string> = new Set<RequestMessage['type']>(['call', 'abort', 'next', 'return']);

export function isRequest(message: Message): message is RequestMessage {
  return REQUESTS.has(message.type);
}

/** Distributes `Omit` over the union so each variant keeps its own fields. */
export type Body<M> = M extends Message ? Omit<M, typeof TAG> : never;

export function message<M extends Message>(body: Body<M>): M {
  return { [TAG]: 1, ...body } as unknown as M;
}

export function isMessage(data: unknown): data is Message {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>)[TAG] === 1;
}
