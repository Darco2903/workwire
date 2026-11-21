export interface BrowserApi {
  add(a: number, b: number): number;
  inWorker(): boolean;
  fill(buffer: ArrayBuffer, value: number): ArrayBuffer;
  fail(): never;
  abortReason(signal: AbortSignal): Promise<string>;
}

export interface CounterApi {
  increment(): number;
}
