# @darco2903/workwire

Typed RPC for **Web Workers** and **Node `worker_threads`**, with worker URLs that survive `tsc`.

- One contract type, checked on both sides: the worker implementation _and_ the caller.
- Errors thrown in the worker are rethrown on the caller's side (name, message, stack, `cause`, `code`, ...).
- `transfer()` to move buffers instead of copying them.
- `AbortSignal` cancellation across threads.
- Async generators / `ReadableStream`s are streamed and consumed with `for await`.
- `createPool()` to spread calls over several workers.
- Same import in the browser and in Node, no `lib: ["webworker"]` needed.

```sh
pnpm add @darco2903/workwire
```

ESM only. Node ≥ 22.18, modern browsers, any bundler that understands `new Worker(new URL(...))` (Vite, webpack 5, Parcel, Rspack).

## Quick start

```ts
// contract.ts: shared by both sides, types only
export interface MathApi {
  add(a: number, b: number): number;
  primes(limit: number, signal?: AbortSignal): Promise<number[]>;
  progress(steps: number): AsyncGenerator<number>;
}
```

```ts
// math.worker.ts
import { expose } from '@darco2903/workwire';
import type { MathApi } from './contract.ts';

expose<MathApi>({
  add: (a, b) => a + b,
  async primes(limit, signal) {
    /* ... signal?.throwIfAborted() ... */
  },
  async *progress(steps) {
    for (let i = 1; i <= steps; i++) yield i / steps;
  },
});
```

**Browser** (keep the literal `new Worker(new URL(...))` form, it's what bundlers detect):

```ts
import { wrap } from '@darco2903/workwire';
import type { MathApi } from './contract.ts';

const math = wrap<MathApi>(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));

await math.add(1, 2); // Promise<number>
for await (const p of math.progress(4)) console.log(p);
```

**Node** (use `createWorker` instead of `new Worker`):

```ts
import { createWorker, wrap } from '@darco2903/workwire';
import type { MathApi } from './contract.ts';

const math = wrap<MathApi>(createWorker(new URL('./math.worker.ts', import.meta.url)));
```

`createWorker` runs `math.worker.ts` directly when Node can strip types, and falls back to `math.worker.js`
when it can't find the `.ts` file, which is what happens after `tsc`: it never rewrites the string inside
`new URL('./x.ts', import.meta.url)`, not even with `rewriteRelativeImportExtensions`. The same source works with
`node main.ts` and with `tsc && node dist/main.js`. (`.mts`/`.cts` map to `.mjs`/`.cjs`.)

The package's `exports` pick the right build automatically (`node` condition vs. `default`). You can also import
`@darco2903/workwire/node` or `@darco2903/workwire/browser` explicitly.

## TypeScript setup

Worker files never touch `self`, so one tsconfig is usually enough: no need to mix the `dom` and `webworker` libs.
If a worker does need worker-only globals (`importScripts`, `self.name`, ...), give the worker files their own
tsconfig with `"lib": ["es2022", "webworker"]`, or declare just what you use:

```ts
declare const self: { name: string };
```

## API

### `expose<T>(api, target?)` → `() => void`

Serve `api` (an object or class instance) to the thread that created the worker. `T` is checked against `api`,
so missing methods or wrong signatures are compile errors. Defaults to `self` in a dedicated worker (every
connecting port in a `SharedWorker`) and to `parentPort` in Node. Returns a function that stops serving.

`exposeOn(api, target)` is the platform-independent version that always takes a target (e.g. a `MessagePort`).

### `wrap<T>(target)` → `Remote<T>`

`target` is a `Worker`, `MessagePort`, `SharedWorker#port`, Node `Worker`/`MessagePort`, or a custom `Endpoint`.
Every method of `T` becomes `(...args) => Promise<Result>`; methods returning an async iterable become
`(...args) => RemoteStream<Item>`.

- If the worker exits or fails to load, pending and future calls reject with `WorkerClosedError`.
- `remote[release]()` rejects pending calls and terminates the worker (or closes the port).

### Errors

An `Error` thrown in the worker rejects the call with a `RemoteError` carrying the original `name` and `message`,
own primitive properties (`code`, `errno`, ...) and a `cause` chain. `stack` shows the worker frames, then
`--- worker boundary ---`, then the caller's frames. Non-`Error` values (`throw 'x'`) are rethrown as-is.

### `transfer(value, transferables)`

Mark an argument or a return value (or a yielded value) so its buffers are moved, not copied:

```ts
await remote.process(transfer(pixels, [pixels.buffer]));
```

### Cancellation

Pass an `AbortSignal` anywhere in the arguments. The worker receives its own signal that aborts with the same
reason, and the caller's promise rejects immediately. An already-aborted signal rejects without calling the worker.

```ts
await math.primes(1e9, AbortSignal.timeout(1_000));
```

### Streams

Methods returning an async iterable (async generators, `ReadableStream`, ...) are streamed. Values are pulled one
at a time, so a slow consumer applies backpressure. `break` closes the worker-side generator (its `finally` blocks
run), errors reject the current iteration, and an `AbortSignal` argument cancels the stream. To transfer a
`ReadableStream` as a whole instead, mark it: `transfer(stream, [stream])`.

### `createPool<T>(factory, { size?, concurrency? })` → `Remote<T>`

```ts
const pool = createPool<MathApi>(() => createWorker(new URL('./math.worker.ts', import.meta.url)), { size: 4 });
```

Same interface as `wrap`. Each worker runs at most `concurrency` calls at once (default `1`); further calls wait in
a FIFO queue and start on the first worker that frees up, so a quick call never waits behind a slow one while
another worker is idle. Workers are created lazily (only when none has room), up to `size`
(default `navigator.hardwareConcurrency`).

- A stream occupies its worker until it ends, throws, is closed (`break`) or aborted.
- Aborting a queued call removes it from the queue: it never reaches a worker.
- A dead worker is replaced. Its in-flight calls reject with `WorkerClosedError` (calls are never retried); queued
  calls run on the replacement.
- `pool[release]()` rejects queued calls and terminates every worker.

## Limits

- Arguments and results must be [structured-cloneable](https://developer.mozilla.org/docs/Web/API/Web_Workers_API/Structured_clone_algorithm):
  no functions or class instances (they arrive as plain objects). A non-cloneable value rejects the call with a `DataCloneError`.
- Generic methods lose their type parameters on the caller's side.
- A contract method named `then` can't be called through the proxy (the proxy must not look like a Promise).
- A stream that is never iterated to the end, `break`, or abort stays open in the worker until the worker is released.
  In a pool, it also keeps its worker's slot, so other calls can't use that worker.

## Development

```sh
pnpm install
pnpm check       # node + browser tsconfigs
pnpm test        # unit, real worker_threads, real Chromium (Playwright), Vite example
pnpm build
```

`examples/vite` is a small app using the package as a dependency (`pnpm --filter workwire-vite-example dev`).
