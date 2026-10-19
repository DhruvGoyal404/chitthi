/**
 * Length in Unicode code points: exactly what Postgres `char_length` counts, so limits checked
 * here match the CHECK constraints (an emoji with modifiers counts as several, by design).
 */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}
