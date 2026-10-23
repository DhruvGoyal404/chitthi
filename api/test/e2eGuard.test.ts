import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDisposableDatabase, assertDisposableMediaDir, databaseName } from '../scripts/e2eGuard.js';

describe('e2e never touches development data', () => {
  const url = (db: string) => `postgres://chitthi:pw@127.0.0.1:5435/${db}?sslmode=disable`;

  it('uses only a database whose name ends in _e2e or _test', () => {
    expect(databaseName(url('chitthi_e2e'))).toBe('chitthi_e2e');
    expect(() => { assertDisposableDatabase(url('chitthi_e2e')); }).not.toThrow();
    expect(() => { assertDisposableDatabase(url('chitthi_test')); }).not.toThrow();
    for (const db of ['chitthi', 'postgres', 'chitthi_e2e_backup', 'e2e', 'chitthi_testing', 'chitthi_e2e/../chitthi']) {
      expect(() => { assertDisposableDatabase(url(db)); }, db).toThrow(/refused/);
    }
  });

  it("keeps its media outside the repo's .data (development media)", () => {
    const repo = process.platform === 'win32' ? 'E:\\repo' : '/home/me/repo';
    const tmp = process.platform === 'win32' ? 'C:\\Temp\\chitthi-e2e-media' : '/tmp/chitthi-e2e-media';
    expect(() => { assertDisposableMediaDir(tmp, repo); }).not.toThrow();
    expect(() => { assertDisposableMediaDir('/dev/shm/chitthi-e2e-media', '/home/runner/work/chitthi'); }).not.toThrow();
    for (const dir of [join(repo, '.data'), join(repo, '.data', 'media'), join(repo, '.data', 'media', 'x')]) {
      expect(() => { assertDisposableMediaDir(dir, repo); }, dir).toThrow(/outside/);
    }
    expect(() => { assertDisposableMediaDir('relative/media', repo); }).toThrow(/absolute/);
  });
});
