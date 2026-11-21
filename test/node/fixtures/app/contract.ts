export interface AppApi {
  greet(name: string): string;
  sum(values: number[]): Promise<number>;
}
