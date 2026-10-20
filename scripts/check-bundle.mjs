// Bundle budget for the web build (run after `npm run build -w web`). Sizes are gzip -9, the
// way a browser downloads them. Raise a budget only on purpose, in the same commit as the reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = { js: 150, css: 10 };
const dir = join(import.meta.dirname, '..', 'web', 'dist', 'assets');

const totals = { js: 0, css: 0 };
for (const file of readdirSync(dir)) {
  const kind = file.endsWith('.js') ? 'js' : file.endsWith('.css') ? 'css' : null;
  if (!kind) continue;
  const gz = gzipSync(readFileSync(join(dir, file)), { level: 9 }).length;
  totals[kind] += gz;
  console.log(`${file}: ${(gz / 1024).toFixed(1)} KB gzip`);
}

let failed = false;
for (const kind of /** @type {const} */ (['js', 'css'])) {
  const kb = totals[kind] / 1024;
  const ok = kb <= BUDGET_KB[kind];
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${kind}: ${kb.toFixed(1)} KB of ${String(BUDGET_KB[kind])} KB`);
}
process.exit(failed ? 1 : 0);
