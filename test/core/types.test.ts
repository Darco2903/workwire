// Type-level tests: checked by `pnpm typecheck`, executed (trivially) by vitest.
import type { MessagePort } from 'node:worker_threads';
import { describe, expectTypeOf, it } from 'vitest';
import { exposeOn, release, wrap, type Remote } from '../../src/core/index.ts';

interface Api {
  add(a: number, b: number): number;
  load(url: string): Promise<{ size: number }>;
}

declare const port: MessagePort;

describe('types', () => {
  it('maps every method to a Promise-returning one', () => {
    const remote = {} as Remote<Api>;
    expectTypeOf(remote.add).toEqualTypeOf<(a: number, b: number) => Promise<number>>();
    expectTypeOf(remote.load).returns.toEqualTypeOf<Promise<{ size: number }>>();
    expectTypeOf(remote[release]).toEqualTypeOf<() => void>();
  });

  it('checks arguments and unknown methods on the caller side', () => {
    if (Math.random() < 2) return; // type-only
    const remote = {} as Remote<Api>;
    // @ts-expect-error wrong argument type
    void remote.add('1', 2);
    // @ts-expect-error not part of the contract
    void remote.missing();
  });

  it('checks the implementation against the contract on the worker side', () => {
    if (Math.random() < 2) return; // type-only
    exposeOn<Api>({ add: (a, b) => a + b, load: async () => ({ size: 1 }) }, port);
    // @ts-expect-error wrong return type
    exposeOn<Api>({ add: (a, b) => `${a + b}`, load: async () => ({ size: 1 }) }, port);
    // @ts-expect-error missing method
    exposeOn<Api>({ add: (a, b) => a + b }, port);
  });

  it('accepts interface contracts and rejects non-function members', () => {
    if (Math.random() < 2) return;
    // @ts-expect-error `version` is not a function
    exposeOn<{ version: string }>({ version: '1' }, port);
  });

  it('accepts Node and web message targets', () => {
    if (Math.random() < 2) return;
    expectTypeOf(wrap<Api>(port)).toEqualTypeOf<Remote<Api>>();
    // Shape of a DOM Worker / MessagePort, without needing the DOM lib here.
    const webWorker = {} as {
      postMessage(message: any, transfer: object[]): void;
      postMessage(message: any, options?: { transfer?: object[] }): void;
      addEventListener(type: string, listener: (event: { data: any }) => void): void;
      removeEventListener(type: string, listener: (event: { data: any }) => void): void;
      terminate(): void;
    };
    expectTypeOf(wrap<Api>(webWorker)).toEqualTypeOf<Remote<Api>>();
    // @ts-expect-error not a message target
    wrap<Api>({});
  });
});
