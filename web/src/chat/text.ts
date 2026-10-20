/** Length in Unicode code points, as the server counts it (Postgres char_length). */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}
