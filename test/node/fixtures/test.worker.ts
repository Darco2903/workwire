import { threadId } from 'node:worker_threads';
import { expose, transfer } from '../../../src/node/index.ts';
import type { TestApi } from './contract.ts';

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
  waitForAbort: (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(`aborted: ${signal.reason.message}`)))),
});
