import { expose } from '../../../src/browser/index.ts';
import type { CounterApi } from './contract.ts';

let count = 0;
expose<CounterApi>({ increment: () => ++count });
