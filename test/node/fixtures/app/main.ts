// Written exactly as an end user would: one source, runnable both with
// `node main.ts` (type stripping) and as `tsc` output.
import { createWorker, release, wrap } from '@darco2903/worker-helper';
import type { AppApi } from './contract.ts';

const app = wrap<AppApi>(createWorker(new URL('./worker.ts', import.meta.url)));
try {
  console.log(JSON.stringify({ greet: await app.greet('worker'), sum: await app.sum([1, 2, 3]) }));
} finally {
  app[release]();
}
