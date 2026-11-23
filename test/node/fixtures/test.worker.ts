import { threadId } from 'node:worker_threads';
import { expose, transfer } from '../../../src/node/index.ts';
import type { TestApi } from './contract.ts';

let waitForAbortCalls = 0;

expose<TestApi>({
  add: (a, b) => a + b,
  threadId: () => threadId,
  fill(buffer, value) {
    new Uint8Array(buffer).fill(value);
    return transfer(buffer, [buffer]);
  },
  fail() {
    const error = new Error('no such file') as Error & { code: string };
    error.code = 'ENOENT';
    throw error;
  },
  crash: (code) => process.exit(code),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  slowThreadId: (ms) => new Promise((resolve) => setTimeout(() => resolve(threadId), ms)),
  async *progress(steps) {
    for (let i = 1; i <= steps; i++) yield i / steps;
  },
  waitForAbort(signal) {
    waitForAbortCalls++;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error(`aborted: ${signal.reason.message}`))),
    );
  },
  waitForAbortCalls: () => waitForAbortCalls,
});
