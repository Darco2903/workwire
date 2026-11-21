import { expose } from '@darco2903/worker-helper';
import type { PrimesApi } from './contract.ts';

expose<PrimesApi>({
  countBelow(limit) {
    const sieve = new Uint8Array(limit);
    let count = 0;
    for (let i = 2; i < limit; i++) {
      if (sieve[i]) continue;
      count++;
      for (let j = i * i; j < limit; j += i) sieve[j] = 1;
    }
    return count;
  },
});
