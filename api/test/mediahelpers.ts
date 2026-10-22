import type { Storage } from '../src/media/storage.js';

const TB = 1024 ** 4;

/**
 * The real store, reporting plenty of free space: tests that are not about the disk guard must
 * not depend on how full the machine (or CI runner) running them happens to be.
 */
export const roomy = (base: Storage): Storage => over(base, { space: () => Promise.resolve({ free: TB, total: 2 * TB }) });

/** A store that behaves like `base` except for the given methods (fault injection, fake readings). */
export function over(base: Storage, overrides: Partial<Storage>): Storage {
  return {
    put: (s, o) => base.put(s, o),
    get: (k) => base.get(k),
    delete: (k) => base.delete(k),
    space: () => base.space(),
    list: () => base.list(),
    cleanTemp: (t) => base.cleanTemp(t),
    ...overrides,
  };
}
