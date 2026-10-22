import type { Storage } from '../src/media/storage.js';

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
