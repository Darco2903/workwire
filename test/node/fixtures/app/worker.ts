import { expose } from '@darco2903/workwire';
import type { AppApi } from './contract.ts';

expose<AppApi>({
  greet: (name) => `hello ${name}`,
  sum: async (values) => values.reduce((a, b) => a + b, 0),
});
