import { exposeOn, type Contract, type MessageTarget } from '../core/index.ts';

export * from '../core/index.ts';

interface WorkerGlobals {
  WorkerGlobalScope?: unknown;
  SharedWorkerGlobalScope?: abstract new () => unknown;
  addEventListener(type: 'connect', listener: (event: { ports: readonly MessageTarget[] }) => void): void;
  removeEventListener(type: 'connect', listener: (event: { ports: readonly MessageTarget[] }) => void): void;
}

/**
 * Serve `api` to the page (or other context) that created this worker.
 *
 * @param target Defaults to `self` in a dedicated worker. In a SharedWorker,
 *   every connecting port is served. Pass a `MessagePort` to serve another channel.
 * @returns A function that stops serving.
 */
export function expose<T extends Contract<T>>(api: T, target?: MessageTarget): () => void {
  if (target) return exposeOn(api, target);

  const scope = globalThis as unknown as WorkerGlobals;
  if (scope.WorkerGlobalScope === undefined) {
    throw new Error('expose() was called outside a worker; pass a target explicitly.');
  }

  if (scope.SharedWorkerGlobalScope && scope instanceof scope.SharedWorkerGlobalScope) {
    const stops: Array<() => void> = [];
    const onConnect = (event: { ports: readonly MessageTarget[] }) => {
      for (const port of event.ports) stops.push(exposeOn(api, port));
    };
    scope.addEventListener('connect', onConnect);
    return () => {
      scope.removeEventListener('connect', onConnect);
      for (const stop of stops.splice(0)) stop();
    };
  }

  return exposeOn(api, globalThis as unknown as MessageTarget);
}
