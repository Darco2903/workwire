// End-to-end: the Vite example, depending on the built package by name,
// bundles the worker as its own chunk and works in a real browser.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../examples/vite/', import.meta.url));
const assets = `${root}dist/assets/`;

describe('vite example', () => {
  beforeAll(async () => {
    await build({ root, logLevel: 'silent' });
  }, 60_000);

  it('bundles the worker separately, using the browser build', () => {
    const files = readdirSync(assets);
    const workerChunk = files.find((f) => /^primes\.worker-.*\.js$/.test(f));
    const mainChunk = files.find((f) => /^index-.*\.js$/.test(f));
    expect(workerChunk).toBeDefined();
    expect(mainChunk).toBeDefined();
    const bundles = readFileSync(assets + workerChunk, 'utf8') + readFileSync(assets + mainChunk, 'utf8');
    expect(bundles).not.toContain('worker_threads');
    expect(bundles).toContain('WorkerGlobalScope');
  });

  it('runs in a browser', async () => {
    const server = await preview({ root, logLevel: 'silent', preview: { port: 0, strictPort: false } });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.resolvedUrls!.local[0]!);
      const result = page.locator('#result');
      await result.filter({ hasText: 'primes below' }).waitFor();
      expect(await result.textContent()).toBe('9592 primes below 100000');
    } finally {
      await browser.close();
      await server.close();
    }
  }, 30_000);
});
