import { wrap } from '@darco2903/worker-helper';
import type { PrimesApi } from './contract.ts';

// Keep the literal `new Worker(new URL(...), { type: 'module' })` form:
// that is what Vite (and webpack, Parcel, ...) detect to bundle the worker.
const primes = wrap<PrimesApi>(new Worker(new URL('./primes.worker.ts', import.meta.url), { type: 'module' }));

const form = document.querySelector<HTMLFormElement>('#form')!;
const limit = document.querySelector<HTMLInputElement>('#limit')!;
const result = document.querySelector<HTMLOutputElement>('#result')!;

async function run(): Promise<void> {
  const n = limit.valueAsNumber;
  result.value = 'computing…';
  result.value = `${await primes.countBelow(n)} primes below ${n}`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run();
});
void run();
