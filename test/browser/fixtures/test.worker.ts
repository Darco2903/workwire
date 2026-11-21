// Note: no `self`, no webworker lib needed. The library finds the scope itself.
import { expose, transfer } from '../../../src/browser/index.ts';
import type { BrowserApi } from './contract.ts';

expose<BrowserApi>({
  add: (a, b) => a + b,
  inWorker: () => 'WorkerGlobalScope' in globalThis && !('document' in globalThis),
  fill(buffer, value) {
    new Uint8Array(buffer).fill(value);
    return transfer(buffer, [buffer]);
  },
  abortReason: (signal) =>
    new Promise((resolve) => signal.addEventListener('abort', () => resolve(String(signal.reason?.message)))),
  fail() {
    throw new SyntaxError('bad input');
  },
});
