export interface TestApi {
  add(a: number, b: number): number;
  threadId(): number;
  fill(buffer: ArrayBuffer, value: number): ArrayBuffer;
  fail(): never;
  crash(code: number): void;
  sleep(ms: number): Promise<void>;
}
