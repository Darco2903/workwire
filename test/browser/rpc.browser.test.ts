import { afterEach, describe, expect, it } from 'vitest';
import {
  expose,
  exposeOn,
  release,
  RemoteError,
  transfer,
  WorkerClosedError,
  wrap,
  type Remote,
} from '../../src/browser/index.ts';
import type { BrowserApi, CounterApi } from './fixtures/contract.ts';

const remotes: Remote<unknown>[] = [];
afterEach(() => {
  for (const remote of remotes.splice(0)) remote[release]();
});

function keep<T>(remote: Remote<T>): Remote<T> {
  remotes.push(remote);
  return remote;
}

function spawn() {
  return keep(wrap<BrowserApi>(new Worker(new URL('./fixtures/test.worker.ts', import.meta.url), { type: 'module' })));
}

describe('browser Worker', () => {
  it('calls into a real web worker', async () => {
    const remote = spawn();
    await expect(remote.add(2, 40)).resolves.toBe(42);
    await expect(remote.inWorker()).resolves.toBe(true);
  });

  it('transfers buffers in both directions', async () => {
    const remote = spawn();
    const buffer = new ArrayBuffer(3);
    const filled = await remote.fill(transfer(buffer, [buffer]), 9);
    expect(buffer.byteLength).toBe(0);
    expect([...new Uint8Array(filled)]).toEqual([9, 9, 9]);
  });

  it('rethrows worker errors', async () => {
    const remote = spawn();
    const error = await remote.fail().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ name: 'SyntaxError', message: 'bad input' });
  });

  it('cancels a call in the worker', async () => {
    const remote = spawn();
    const controller = new AbortController();
    const call = remote.abortReason(controller.signal);
    await remote.add(0, 0);
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow('stop');
  });

  it('rejects calls when the worker fails to load', async () => {
    const worker = new Worker(new URL('./fixtures/broken.worker.ts', import.meta.url), { type: 'module' });
    const remote = keep(wrap<BrowserApi>(worker));
    await expect(remote.add(1, 2)).rejects.toBeInstanceOf(WorkerClosedError);
  });

  it('release() rejects later calls', async () => {
    const remote = spawn();
    await remote.add(1, 1);
    remote[release]();
    await expect(remote.add(1, 1)).rejects.toBeInstanceOf(WorkerClosedError);
  });
});

describe('SharedWorker', () => {
  it('serves every connecting port with shared state', async () => {
    const url = new URL('./fixtures/shared.worker.ts', import.meta.url);
    const name = `counter-${Math.random()}`;
    const a = keep(wrap<CounterApi>(new SharedWorker(url, { type: 'module', name }).port));
    const b = keep(wrap<CounterApi>(new SharedWorker(url, { type: 'module', name }).port));
    expect(await a.increment()).toBe(1);
    expect(await b.increment()).toBe(2);
    expect(await a.increment()).toBe(3);
  });
});

describe('web MessagePort', () => {
  it('works over a MessageChannel in the page', async () => {
    const { port1, port2 } = new MessageChannel();
    const stop = exposeOn({ twice: (n: number) => n * 2 }, port2);
    const remote = keep(wrap<{ twice(n: number): number }>(port1));
    await expect(remote.twice(21)).resolves.toBe(42);
    stop();
    port2.close();
  });

  it('expose() without a target throws outside a worker', () => {
    expect(() => expose({})).toThrow(/outside a worker/);
  });
});
