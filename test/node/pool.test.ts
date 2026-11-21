import { afterEach, describe, expect, it } from 'vitest';
import { createPool, createWorker, release, WorkerClosedError, type Remote } from '../../src/node/index.ts';
import type { TestApi } from './fixtures/contract.ts';

const workerUrl = new URL('./fixtures/test.worker.ts', import.meta.url);
const pools: Remote<unknown>[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool[release]();
});

function pool(size: number) {
  let created = 0;
  const remote = createPool<TestApi>(
    () => {
      created++;
      return createWorker(workerUrl);
    },
    { size },
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
});
