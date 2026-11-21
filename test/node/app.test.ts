// End-to-end: an app that imports the published package name runs unchanged
// from .ts sources (Node type stripping) and from plain `tsc` output.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)); // package built by global-setup
const appDir = fileURLToPath(new URL('./fixtures/app/', import.meta.url));
const expected = { greet: 'hello worker', sum: 6 };

function run(entry: string): unknown {
  return JSON.parse(execFileSync(process.execPath, [entry], { cwd: appDir, encoding: 'utf8' }));
}

describe('packaged usage', () => {
  beforeAll(() => {
    rmSync(`${appDir}dist`, { recursive: true, force: true });
    execFileSync(`${root}node_modules/.bin/tsc`, ['-p', `${appDir}tsconfig.json`], { cwd: root });
  }, 60_000);

  it('runs from .ts sources', () => {
    expect(run('main.ts')).toEqual(expected);
  });

  it('runs from tsc output even though the source says ./worker.ts', () => {
    expect(existsSync(`${appDir}dist/worker.ts`)).toBe(false);
    expect(readdirSync(`${appDir}dist`)).toContain('worker.js');
    expect(run('dist/main.js')).toEqual(expected);
  });
});
