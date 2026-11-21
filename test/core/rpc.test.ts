import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { exposeOn, release, RemoteError, transfer, WorkerClosedError, wrap } from '../../src/core/index.ts';

interface Api {
  add(a: number, b: number): number;
  slow(ms: number, value: string): Promise<string>;
  fail(message: string): never;
  failWithCause(): never;
  throwValue(): never;
  bufferLength(buffer: ArrayBuffer): number;
  makeBuffer(size: number): ArrayBuffer;
  returnFunction(): () => void;
}

const api: Api = {
  add: (a, b) => a + b,
  slow: (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
  fail(message) {
    throw Object.assign(new RangeError(message), { code: 'E_RANGE', nested: { no: 'objects' } });
  },
  failWithCause() {
    throw new Error('outer', { cause: new TypeError('inner') });
  },
  throwValue() {
    throw { reason: 'plain object' };
  },
  bufferLength: (buffer) => buffer.byteLength,
  makeBuffer(size) {
    const buffer = new ArrayBuffer(size);
    return transfer(buffer, [buffer]);
  },
  returnFunction: () => () => {},
};

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function setup<T extends object>(impl: T) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const stop = exposeOn(impl as any, port2);
  return { remote: wrap<T>(port1), port1, port2, stop };
}

describe('wrap / exposeOn', () => {
  it('calls sync and async methods', async () => {
    const { remote } = setup(api);
    await expect(remote.add(2, 3)).resolves.toBe(5);
    await expect(remote.slow(5, 'done')).resolves.toBe('done');
  });

  it('matches concurrent responses to their callers', async () => {
    const { remote } = setup(api);
    const results = await Promise.all([remote.slow(30, 'a'), remote.slow(5, 'b'), remote.add(1, 1)]);
    expect(results).toEqual(['a', 'b', 2]);
  });

  it('rebuilds thrown errors with name, message, primitive props and remote stack', async () => {
    const { remote } = setup(api);
    const error = await remote.fail('too big').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ name: 'RangeError', message: 'too big', code: 'E_RANGE' });
    expect((error as RemoteError).nested).toBeUndefined();
    expect((error as RemoteError).remoteStack).toContain('RangeError: too big');
    expect((error as Error).stack).toContain('--- worker boundary ---');
  });

  it('keeps the error cause chain', async () => {
    const { remote } = setup(api);
    const error = (await remote.failWithCause().catch((e: unknown) => e)) as RemoteError;
    expect(error.message).toBe('outer');
    expect(error.cause).toBeInstanceOf(RemoteError);
    expect(error.cause).toMatchObject({ name: 'TypeError', message: 'inner' });
  });

  it('rethrows non-Error values as-is', async () => {
    const { remote } = setup(api);
    await expect(remote.throwValue()).rejects.toEqual({ reason: 'plain object' });
  });

  it('rejects unknown and inherited methods', async () => {
    const { remote } = setup(api);
    const r = remote as any;
    await expect(r.nope()).rejects.toMatchObject({ name: 'TypeError', message: 'Unknown method "nope"' });
    await expect(r.toString()).rejects.toMatchObject({ message: 'Unknown method "toString"' });
    await expect(r.constructor()).rejects.toMatchObject({ message: 'Unknown method "constructor"' });
  });

  it('calls class methods with the right `this`', async () => {
    class Counter {
      count = 0;
      increment(by: number) {
        this.count += by;
        return this.count;
      }
    }
    const { remote } = setup(new Counter());
    await remote.increment(2);
    await expect(remote.increment(3)).resolves.toBe(5);
  });

  it('transfers marked arguments instead of copying them', async () => {
    const { remote } = setup(api);
    const buffer = new ArrayBuffer(16);
    await expect(remote.bufferLength(transfer(buffer, [buffer]))).resolves.toBe(16);
    expect(buffer.byteLength).toBe(0); // detached: it was moved, not copied
  });

  it('copies unmarked arguments', async () => {
    const { remote } = setup(api);
    const buffer = new ArrayBuffer(16);
    await remote.bufferLength(buffer);
    expect(buffer.byteLength).toBe(16);
  });

  it('transfers marked return values', async () => {
    const { remote } = setup(api);
    const buffer = await remote.makeBuffer(8);
    expect(buffer.byteLength).toBe(8);
  });

  it('rejects non-cloneable arguments and return values', async () => {
    const { remote } = setup(api);
    await expect((remote as any).add(() => {}, 1)).rejects.toThrow(/could not be cloned/);
    await expect(remote.returnFunction()).rejects.toMatchObject({ name: 'DataCloneError' });
  });

  it('release() rejects pending and future calls', async () => {
    const { remote } = setup(api);
    const pending = remote.slow(50, 'late');
    remote[release]();
    await expect(pending).rejects.toBeInstanceOf(WorkerClosedError);
    await expect(remote.add(1, 2)).rejects.toThrow('Remote was released');
  });

  it('rejects pending calls when the port closes', async () => {
    const { remote, port2 } = setup(api);
    const pending = remote.slow(50, 'late');
    port2.close();
    await expect(pending).rejects.toBeInstanceOf(WorkerClosedError);
  });

  it('is not thenable, so it can be returned from async functions', async () => {
    const { remote } = setup(api);
    const same = await (async () => remote)();
    await expect(same.add(1, 1)).resolves.toBe(2);
  });

  it('ignores foreign messages on a shared channel', async () => {
    const { remote, port1 } = setup(api);
    const seen: unknown[] = [];
    port1.on('message', (m) => seen.push(m));
    // A non-library message sent from the exposing side must not break anything.
    ports.at(-1)!.postMessage({ hello: 'world' });
    await expect(remote.add(1, 2)).resolves.toBe(3);
    expect(seen).toContainEqual({ hello: 'world' });
  });

  it('stop() stops serving', async () => {
    const { remote, stop } = setup(api);
    stop();
    const result = await Promise.race([remote.add(1, 2), new Promise((r) => setTimeout(() => r('timeout'), 30))]);
    expect(result).toBe('timeout');
  });
});
