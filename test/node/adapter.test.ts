import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { threadId as mainThreadId } from 'node:worker_threads';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createWorker,
  expose,
  release,
  RemoteError,
  resolveWorkerUrl,
  transfer,
  WorkerClosedError,
  wrap,
  type Remote,
} from '../../src/node/index.ts';
import type { TestApi } from './fixtures/contract.ts';

const workerUrl = new URL('./fixtures/test.worker.ts', import.meta.url);
const remotes: Remote<unknown>[] = [];
afterEach(() => {
  for (const remote of remotes.splice(0)) remote[release]();
});

function spawn() {
  const remote = wrap<TestApi>(createWorker(workerUrl));
  remotes.push(remote);
  return remote;
}

describe('node worker_threads', () => {
  it('calls into a real worker thread', async () => {
    const remote = spawn();
    await expect(remote.add(20, 22)).resolves.toBe(42);
    const id = await remote.threadId();
    expect(id).not.toBe(mainThreadId);
  });

  it('transfers buffers in both directions', async () => {
    const remote = spawn();
    const buffer = new ArrayBuffer(4);
    const filled = await remote.fill(transfer(buffer, [buffer]), 7);
    expect(buffer.byteLength).toBe(0);
    expect([...new Uint8Array(filled)]).toEqual([7, 7, 7, 7]);
  });

  it('rethrows worker errors with their code', async () => {
    const remote = spawn();
    const error = await remote.fail().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ message: 'no such file', code: 'ENOENT' });
  });

  it('rejects pending and later calls when the worker exits', async () => {
    const remote = spawn();
    await remote.add(0, 0); // make sure it is up
    const pending = remote.sleep(1_000);
    void remote.crash(3).catch(() => {});
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerClosedError);
    expect((error as Error).message).toBe('Worker exited with code 3');
    await expect(remote.add(1, 1)).rejects.toBeInstanceOf(WorkerClosedError);
  });

  it('rejects calls when the worker fails to load', async () => {
    const remote = wrap<TestApi>(createWorker(new URL('./fixtures/broken.worker.ts', import.meta.url)));
    remotes.push(remote);
    const error = await remote.add(1, 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerClosedError);
    expect((error as Error).cause).toMatchObject({ message: 'boom at load time' });
  });

  it('streams values from the worker thread', async () => {
    const remote = spawn();
    const values: number[] = [];
    for await (const value of remote.progress(4)) values.push(value);
    expect(values).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('cancels a call in the worker thread', async () => {
    const remote = spawn();
    const controller = new AbortController();
    const call = remote.waitForAbort(controller.signal);
    await remote.add(0, 0);
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow('stop');
  });

  it('release() terminates the worker', async () => {
    const worker = createWorker(workerUrl);
    const remote = wrap<TestApi>(worker);
    await remote.add(1, 1);
    const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
    remote[release]();
    await expect(exited).resolves.toBeTypeOf('number');
  });

  it('expose() outside a worker thread throws a clear error', () => {
    expect(() => expose({})).toThrow(/outside a worker thread/);
  });
});

describe('resolveWorkerUrl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workwire-'));
  const url = (name: string) => pathToFileURL(join(dir, name));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps an existing .ts file', () => {
    writeFileSync(join(dir, 'a.ts'), '');
    writeFileSync(join(dir, 'a.js'), '');
    expect(resolveWorkerUrl(url('a.ts')).href).toBe(url('a.ts').href);
  });

  it('falls back to the compiled extension when the .ts file is missing', () => {
    writeFileSync(join(dir, 'b.js'), '');
    writeFileSync(join(dir, 'c.mjs'), '');
    writeFileSync(join(dir, 'd.cjs'), '');
    expect(resolveWorkerUrl(url('b.ts')).href).toBe(url('b.js').href);
    expect(resolveWorkerUrl(url('c.mts')).href).toBe(url('c.mjs').href);
    expect(resolveWorkerUrl(url('d.cts')).href).toBe(url('d.cjs').href);
  });

  it('returns the original URL when nothing matches', () => {
    expect(resolveWorkerUrl(url('missing.ts')).href).toBe(url('missing.ts').href);
    expect(resolveWorkerUrl(url('plain.js')).href).toBe(url('plain.js').href);
  });

  it('accepts paths and URL strings', () => {
    writeFileSync(join(dir, 'e.js'), '');
    expect(resolveWorkerUrl(join(dir, 'e.ts')).href).toBe(url('e.js').href);
    expect(resolveWorkerUrl(url('e.ts').href).href).toBe(url('e.js').href);
  });
});
