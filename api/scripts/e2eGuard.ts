import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Local and CI end-to-end runs must never touch the development database or dev media. These
 * checks run before the e2e API starts (api/scripts/e2e-db.ts); a refusal stops the run.
 */

/** The database name in a postgres:// URL. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Only a throwaway database may be recreated and used by e2e: its name ends in _e2e or _test. */
export function assertDisposableDatabase(url: string): void {
  const name = databaseName(url);
  if (!/_(e2e|test)$/.test(name)) {
    throw new Error(`refused: e2e may only use a database whose name ends in _e2e or _test, not "${name}"`);
  }
}

/** The e2e media folder must be absolute and must not be (or be inside) the repo's dev media area. */
export function assertDisposableMediaDir(mediaDir: string, repoRoot: string): void {
  if (!isAbsolute(mediaDir)) throw new Error('refused: the e2e MEDIA_DIR must be an absolute path');
  const data = resolve(repoRoot, '.data');
  const rel = relative(data, resolve(mediaDir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`refused: the e2e MEDIA_DIR must be outside ${data} (that is development media)`);
  }
}
