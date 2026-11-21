import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { exposeOn, release, transfer, WorkerClosedError, wrap } from '../../src/core/index.ts';

interface Api {
  count(n: number, delay?: number, signal?: AbortSignal): AsyncGenerator<number>;
  failAfter(n: number): AsyncGenerator<number>;
  failBeforeStart(): AsyncGenerator<number>;
  later(n: number): Promise<AsyncIterable<number>>;
  readable(values: string[]): ReadableStream<string>;
  buffers(n: number): AsyncGenerator<ArrayBuffer>;
  cleanups(): number;
  plain(): number;
}

function createApi(): Api {
  let cleanups = 0;
  async function* count(n: number, delay = 0, signal?: AbortSignal) {
    try {
      for (let i = 0; i < n; i++) {
        signal?.throwIfAborted();
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        yield i;
      }
    } finally {
      cleanups++;
    }
  }
  return {
    count,
    async *failAfter(n) {
      yield* count(n);
      throw new RangeError('stream broke');
    },
    failBeforeStart() {
      throw new Error('bad arguments');
    },
    later: async (n) => count(n),
    readable: (values) =>
      new ReadableStream({
        start(controller) {
          for (const value of values) controller.enqueue(value);
          controller.close();
        },
      }),
    async *buffers(n) {
      for (let i = 0; i < n; i++) {
        const buffer = new Uint8Array([i]).buffer;
        yield transfer(buffer, [buffer]);
      }
    },
    cleanups: () => cleanups,
    plain: () => 1,
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

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('streams', () => {
  it('streams async generator values in order', async () => {
    const remote = setup();
    await expect(collect(remote.count(5))).resolves.toEqual([0, 1, 2, 3, 4]);
    await expect(remote.cleanups()).resolves.toBe(1);
  });

  it('streams async iterables returned from async functions', async () => {
    const remote = setup();
    await expect(collect(remote.later(3))).resolves.toEqual([0, 1, 2]);
  });

  it('streams ReadableStreams', async () => {
    const remote = setup();
    await expect(collect(remote.readable(['a', 'b']))).resolves.toEqual(['a', 'b']);
  });

  it('runs the worker generator `finally` on break', async () => {
    const remote = setup();
    const seen: number[] = [];
    for await (const value of remote.count(1_000)) {
      seen.push(value);
      if (value === 2) break;
    }
    expect(seen).toEqual([0, 1, 2]);
    await expect(remote.cleanups()).resolves.toBe(1);
  });

  it('delivers values before a mid-stream error, then rejects', async () => {
    const remote = setup();
    const seen: number[] = [];
    const error = await (async () => {
      for await (const value of remote.failAfter(2)) seen.push(value);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([0, 1]);
    expect(error).toMatchObject({ name: 'RangeError', message: 'stream broke' });
  });

  it('rejects iteration when the method throws before streaming', async () => {
    const remote = setup();
    await expect(collect(remote.failBeforeStart())).rejects.toThrow('bad arguments');
  });

  it('serialises concurrent next() calls', async () => {
    const remote = setup();
    const iterator = remote.count(3)[Symbol.asyncIterator]();
    const results = await Promise.all([iterator.next(), iterator.next(), iterator.next(), iterator.next()]);
    expect(results).toEqual([
      { value: 0, done: false },
      { value: 1, done: false },
      { value: 2, done: false },
      { value: undefined, done: true },
    ]);
  });

  it('transfers marked yielded values', async () => {
    const remote = setup();
    const buffers = await collect(remote.buffers(2));
    expect(buffers.map((b) => new Uint8Array(b)[0])).toEqual([0, 1]);
  });

  it('aborts a stream with its signal and closes the worker generator', async () => {
    const remote = setup();
    const controller = new AbortController();
    const seen: number[] = [];
    const error = await (async () => {
      for await (const value of remote.count(1_000, 5, controller.signal)) {
        seen.push(value);
        if (value === 1) controller.abort(new Error('enough'));
      }
    })().catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'enough' });
    expect(seen).toEqual([0, 1]);
    await tick();
    await expect(remote.cleanups()).resolves.toBe(1);
  });

  it('rejects iterating a method that does not stream', async () => {
    const remote = setup();
    await expect(collect(remote.plain() as unknown as AsyncIterable<number>)).rejects.toThrow(
      'plain() did not return an async iterable',
    );
  });

  it('rejects the stream when the remote is released', async () => {
    const remote = setup();
    const iterator = remote.count(1_000, 50)[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    remote[release]();
    await expect(pending).rejects.toBeInstanceOf(WorkerClosedError);
  });
});
