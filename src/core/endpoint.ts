/**
 * Anything that can be transferred instead of copied (ArrayBuffer, MessagePort,
 * ImageBitmap, OffscreenCanvas, ...). Kept as `object` so the library does not
 * depend on the DOM or webworker `lib`.
 */
export type Transferable = object;

/** Normalised channel used internally by `expose` and `wrap`. */
export interface Endpoint {
  post(message: unknown, transfer: readonly Transferable[]): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  listen(handler: (data: unknown) => void): () => void;
  /** Subscribe to fatal failures (worker exited, failed to load, ...). */
  onFatal?(handler: (error: Error) => void): () => void;
  /** Release the underlying resource (terminate the worker, close the port). */
  close?(): void;
}

/**
 * Web-style target: browser `Worker`, worker `self`, `MessagePort`.
 * Typed structurally so that DOM types are accepted without the DOM `lib`.
 */
export interface WebMessageTarget {
  postMessage(message: any, transfer: any[]): void;
  addEventListener(type: 'message', listener: (event: any) => void): void;
  removeEventListener(type: 'message', listener: (event: any) => void): void;
  start?(): void;
}

/** Node-style target: `worker_threads` `Worker`, `MessagePort`, `parentPort`. */
export interface NodeMessageTarget {
  postMessage(message: any, transferList?: readonly any[]): void;
  on(event: 'message', listener: (value: any) => void): unknown;
  off(event: 'message', listener: (value: any) => void): unknown;
}

export type MessageTarget = Endpoint | WebMessageTarget | NodeMessageTarget;

function isEndpoint(target: MessageTarget): target is Endpoint {
  return typeof (target as Endpoint).post === 'function' && typeof (target as Endpoint).listen === 'function';
}

function isNodeTarget(target: MessageTarget): target is NodeMessageTarget {
  return typeof (target as NodeMessageTarget).on === 'function' && typeof (target as NodeMessageTarget).off === 'function';
}

function fromNode(target: NodeMessageTarget): Endpoint {
  const t = target as NodeMessageTarget & {
    terminate?(): unknown;
    close?(): void;
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  };
  const isWorker = typeof t.terminate === 'function';
  return {
    post: (message, transfer) => t.postMessage(message, transfer as any[]),
    listen(handler) {
      t.on('message', handler);
      return () => void t.off('message', handler);
    },
    onFatal(handler) {
      const onExit = (code: number) => handler(new Error(`Worker exited with code ${code}`));
      const onClose = () => handler(new Error('Message port closed'));
      const onError = (error: unknown) =>
        handler(error instanceof Error ? error : new Error(`Worker error: ${String(error)}`));
      if (isWorker) {
        t.on('error', onError);
        t.on('exit', onExit);
      } else {
        t.on('close', onClose);
      }
      return () => {
        if (isWorker) {
          t.off('error', onError);
          t.off('exit', onExit);
        } else {
          t.off('close', onClose);
        }
      };
    },
    close() {
      if (isWorker) void t.terminate!();
      else t.close?.();
    },
  };
}

function fromWeb(target: WebMessageTarget): Endpoint {
  const t = target as WebMessageTarget & {
    terminate?(): void;
    close?(): void;
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  };
  const isWorker = typeof t.terminate === 'function';
  return {
    post: (message, transfer) => t.postMessage(message, transfer as any[]),
    listen(handler) {
      const listener = (event: { data: unknown }) => handler(event.data);
      t.addEventListener('message', listener);
      t.start?.(); // MessagePort only delivers after start() when using addEventListener
      return () => t.removeEventListener('message', listener);
    },
    onFatal(handler) {
      if (!isWorker) return () => {};
      // A browser Worker fires `error` when its script fails to load or throws
      // at top level; without this, pending calls would hang forever.
      const listener = (event: { message?: string; preventDefault?(): void }) =>
        handler(new Error(event.message ? `Worker error: ${event.message}` : 'Worker failed to load'));
      t.addEventListener('error', listener);
      return () => t.removeEventListener('error', listener);
    },
    close() {
      if (isWorker) t.terminate!();
      else t.close?.();
    },
  };
}

/** Normalise a Worker / MessagePort / self / custom endpoint into an `Endpoint`. */
export function toEndpoint(target: MessageTarget): Endpoint {
  if (isEndpoint(target)) return target;
  // Node MessagePorts also implement addEventListener, so check Node-style first.
  if (isNodeTarget(target)) return fromNode(target);
  return fromWeb(target);
}
