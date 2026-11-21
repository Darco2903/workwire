import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, Worker, type WorkerOptions } from 'node:worker_threads';
import { exposeOn, type Contract, type MessageTarget } from '../core/index.ts';

export * from '../core/index.ts';

/**
 * Serve `api` to the thread that created this worker.
 *
 * @param target Defaults to `parentPort`. Pass a `MessagePort` to serve on another channel.
 * @returns A function that stops serving.
 */
export function expose<T extends Contract<T>>(api: T, target?: MessageTarget): () => void {
  const resolved = target ?? parentPort;
  if (!resolved) {
    throw new Error('expose() was called outside a worker thread; pass a target explicitly.');
  }
  return exposeOn(api, resolved);
}

const JS_EXTENSIONS: Record<string, string> = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs', '.tsx': '.js' };

function canRunTypeScript(): boolean {
  return Boolean((process.features as { typescript?: string | false }).typescript);
}

/**
 * Resolve a worker URL that was written against the `.ts` source so it also
 * works after `tsc` (which never rewrites `new URL('./x.ts', import.meta.url)`).
 *
 * - `.ts` file exists and Node can strip types → use it.
 * - otherwise, if the matching `.js` / `.mjs` / `.cjs` exists → use that.
 * - otherwise the URL is returned unchanged, so `Worker` reports the real error.
 *
 * @param url A `file:` URL (usually `new URL('./worker.ts', import.meta.url)`) or a path.
 */
export function resolveWorkerUrl(url: URL | string): URL {
  const input =
    url instanceof URL ? url : /^[a-z][a-z\d+.-]*:/i.test(url) ? new URL(url) : pathToFileURL(resolve(url));
  if (input.protocol !== 'file:') return input;

  const match = /\.(?:m|c)?tsx?$/.exec(input.pathname);
  if (!match) return input;

  const tsExists = existsSync(fileURLToPath(input));
  if (tsExists && canRunTypeScript()) return input;

  const js = new URL(input.href);
  js.pathname = input.pathname.slice(0, match.index) + JS_EXTENSIONS[match[0]]!;
  if (existsSync(fileURLToPath(js))) return js;
  return input;
}

/**
 * `new Worker(...)` with {@link resolveWorkerUrl} applied, so the same
 * `new URL('./worker.ts', import.meta.url)` works from sources and from `tsc` output.
 *
 * @example
 * const math = wrap<MathApi>(createWorker(new URL('./math.worker.ts', import.meta.url)));
 */
export function createWorker(url: URL | string, options?: WorkerOptions): Worker {
  return new Worker(resolveWorkerUrl(url), options);
}
