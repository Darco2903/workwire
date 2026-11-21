import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { exposeOn, wrap } from '../../src/core/index.ts';

interface Api {
  wait(ms: number, signal?: AbortSignal): Promise<string>;
  lastAbortReason(): unknown;
  started(): number;
}

function createApi(): Api {
  let reason: unknown;
  let started = 0;
  return {
    wait(ms, signal) {
      started++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('finished'), ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          // Return plain data: structured clone drops non-standard Error names.
          reason = { name: signal.reason.name, message: signal.reason.message };
          reject(signal.reason);
        });
      });
    },
    lastAbortReason: () => reason,
    started: () => started,
  };
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function setup() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  exposeOn(createApi(), port2);
  return wrap<Api>(port1);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('AbortSignal', () => {
  it('passes a working signal that completes normally when not aborted', async () => {
    const remote = setup();
    await expect(remote.wait(5, new AbortController().signal)).resolves.toBe('finished');
  });

  it('rejects the caller immediately and aborts the worker-side signal', async () => {
    const remote = setup();
    const controller = new AbortController();
    const call = remote.wait(10_000, controller.signal);
    await tick();
    controller.abort(new Error('user cancelled'));
    await expect(call).rejects.toThrow('user cancelled');
    await tick();
    await expect(remote.lastAbortReason()).resolves.toMatchObject({ message: 'user cancelled' });
  });

  it('forwards the default AbortError reason', async () => {
    const remote = setup();
    const controller = new AbortController();
    const call = remote.wait(10_000, controller.signal);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    await expect(remote.lastAbortReason()).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('works with AbortSignal.timeout()', async () => {
    const remote = setup();
    await expect(remote.wait(10_000, AbortSignal.timeout(20))).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('does not even send the call when the signal is already aborted', async () => {
    const remote = setup();
    const reason = new Error('too late');
    await expect(remote.wait(5, AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(remote.started()).resolves.toBe(0);
  });

  it('ignores aborts after the call settled', async () => {
    const remote = setup();
    const controller = new AbortController();
    await expect(remote.wait(1, controller.signal)).resolves.toBe('finished');
    controller.abort();
    await tick();
    await expect(remote.lastAbortReason()).resolves.toBeUndefined();
  });
});
