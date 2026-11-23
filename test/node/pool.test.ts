import { afterEach, describe, expect, it } from 'vitest';
import { createPool, createWorker, release, WorkerClosedError, type PoolOptions, type Remote } from '../../src/node/index.ts';
import type { TestApi } from './fixtures/contract.ts';

const workerUrl = new URL('./fixtures/test.worker.ts', import.meta.url);
const pools: Remote<unknown>[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves to whether `promise` settled within `ms`. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true, () => true), delay(ms).then(() => false)]);
afterEach(() => {
  for (const pool of pools.splice(0)) pool[release]();
});

function pool(size: number, options: Omit<PoolOptions, 'size'> = {}) {
  let created = 0;
  const remote = createPool<TestApi>(
    () => {
      created++;
      return createWorker(workerUrl);
    },
    { size, ...options },
  );
  pools.push(remote);
  return { remote, created: () => created };
}

describe('createPool', () => {
  it('spreads concurrent calls over up to `size` threads', async () => {
    const { remote, created } = pool(3);
    const ids = await Promise.all(Array.from({ length: 6 }, () => remote.slowThreadId(50)));
    expect(new Set(ids).size).toBe(3);
    expect(created()).toBe(3);
  });

  it('creates workers lazily', async () => {
    const { remote, created } = pool(4);
    for (let i = 0; i < 5; i++) await remote.add(i, i);
    expect(created()).toBe(1);
  });

  it('replaces a worker that died', async () => {
    const { remote, created } = pool(1);
    const first = await remote.threadId();
    await expect(remote.crash(1)).rejects.toBeInstanceOf(WorkerClosedError);
    const second = await remote.threadId();
    expect(second).not.toBe(first);
    expect(created()).toBe(2);
  });

  it('streams through the pool', async () => {
    const { remote } = pool(2);
    const values: number[] = [];
    for await (const value of remote.progress(2)) values.push(value);
    expect(values).toEqual([0.5, 1]);
  });

  it('release() rejects later calls', async () => {
    const { remote } = pool(2);
    await remote.add(1, 1);
    remote[release]();
    await expect(remote.add(1, 1)).rejects.toThrow('Pool was released');
  });

  it('runs a queued call on the first worker that frees up', async () => {
    const { remote } = pool(2);
    const order: string[] = [];
    const track = (name: string, promise: Promise<number>) => promise.then((id) => (order.push(name), id));
    const slow = track('slow', remote.slowThreadId(300));
    const fast = track('fast', remote.slowThreadId(20));
    const queued = track('queued', remote.slowThreadId(20));
    const [slowId, fastId, queuedId] = await Promise.all([slow, fast, queued]);
    expect(queuedId).toBe(fastId);
    expect(queuedId).not.toBe(slowId);
    expect(order).toEqual(['fast', 'queued', 'slow']);
  });

  it('runs up to `concurrency` calls on one worker', async () => {
    const { remote, created } = pool(2, { concurrency: 2 });
    const ids = await Promise.all([remote.slowThreadId(50), remote.slowThreadId(50)]);
    expect(ids[0]).toBe(ids[1]);
    expect(created()).toBe(1);
  });

  it('drops an aborted call from the queue without sending it', async () => {
    const { remote } = pool(1);
    const busy = remote.sleep(100);
    const controller = new AbortController();
    const queued = remote.waitForAbort(controller.signal);
    controller.abort(new Error('stop'));
    await expect(queued).rejects.toThrow('stop');
    await busy;
    expect(await remote.waitForAbortCalls()).toBe(0);
  });

  it('runs queued calls on the replacement of a worker that died', async () => {
    const { remote, created } = pool(1);
    const first = await remote.threadId();
    const crash = remote.crash(1);
    const queued = remote.threadId();
    await expect(crash).rejects.toBeInstanceOf(WorkerClosedError);
    expect(await queued).not.toBe(first);
    expect(created()).toBe(2);
  });

  it('keeps a worker occupied until its stream is closed', async () => {
    const { remote } = pool(1);
    const iterator = remote.progress(3)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1 / 3, done: false });
    const queued = remote.add(1, 1);
    expect(await settlesWithin(queued, 100)).toBe(false);
    await iterator.return!();
    expect(await queued).toBe(2);
  });

  it('frees the worker when a stream finishes', async () => {
    const { remote, created } = pool(1);
    for await (const _ of remote.progress(2));
    expect(await remote.add(1, 1)).toBe(2);
    expect(created()).toBe(1);
  });

  it('frees the worker when a stream is aborted', async () => {
    const { remote } = pool(1);
    const controller = new AbortController();
    const iterator = remote.progress(3, controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    const queued = remote.add(1, 1);
    expect(await settlesWithin(queued, 100)).toBe(false);
    controller.abort();
    expect(await queued).toBe(2);
  });

  it('release() rejects queued calls', async () => {
    const { remote } = pool(1);
    const busy = remote.sleep(100);
    const queued = remote.add(1, 1);
    remote[release]();
    await expect(queued).rejects.toThrow('Pool was released');
    await expect(busy).rejects.toBeInstanceOf(WorkerClosedError);
  });
});
