import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_DIR } from '../playwright.config.js';

/** After every run: the e2e media folder goes (never the repo's dev media in .data). */
export default async function teardown(): Promise<void> {
  const data = resolve(fileURLToPath(new URL('../../.data', import.meta.url)));
  const rel = relative(data, resolve(MEDIA_DIR));
  const insideDevData = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!isAbsolute(MEDIA_DIR) || insideDevData) throw new Error(`refusing to delete ${MEDIA_DIR}`);
  await rm(MEDIA_DIR, { recursive: true, force: true });
}
