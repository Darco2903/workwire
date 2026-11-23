export interface TestApi {
  add(a: number, b: number): number;
  threadId(): number;
  fill(buffer: ArrayBuffer, value: number): ArrayBuffer;
  fail(): never;
  crash(code: number): void;
  sleep(ms: number): Promise<void>;
  waitForAbort(signal: AbortSignal): Promise<string>;
  /** How many times `waitForAbort` was called in this worker. */
  waitForAbortCalls(): number;
  progress(steps: number, signal?: AbortSignal): AsyncGenerator<number>;
  slowThreadId(ms: number): Promise<number>;
}
