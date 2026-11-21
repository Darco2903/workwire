import type { SerializedError } from './errors.ts';

/** Marker so unrelated messages on a shared channel are ignored. */
export const TAG = '__workerHelper';

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

export type Message = CallMessage | AbortMessage | ResultMessage | ErrorMessage;

/** Distributes `Omit` over the union so each variant keeps its own fields. */
type Body<M> = M extends Message ? Omit<M, typeof TAG> : never;

export function message<M extends Message>(body: Body<M>): M {
  return { [TAG]: 1, ...body } as unknown as M;
}

export function isMessage(data: unknown): data is Message {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>)[TAG] === 1;
}
