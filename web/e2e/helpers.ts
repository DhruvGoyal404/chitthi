import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

export const handle = (prefix = 'e2e') => `${prefix}_${randomBytes(5).toString('hex')}`;

/** A signed-in browser context of its own (cookies are per context, like separate devices). */
export async function signedIn(browser: Browser, prefix = 'e2e', opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page; handle: string; id: string }> {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const h = handle(prefix);
  await page.goto('/signin');
  await page.getByLabel('Your handle').fill(h);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  const me = await page.request.get('/api/me');
  const { user } = (await me.json()) as { user: { id: string } };
  return { context, page, handle: h, id: user.id };
}

/** Starts (or opens) a DM from `page` with the user whose handle is `other`. */
export async function openDm(page: Page, other: string): Promise<string> {
  await page.goto('/new');
  await page.getByLabel('Find someone by handle').fill(other);
  await page.getByRole('button', { name: new RegExp(other) }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  return page.url().split('/c/')[1] ?? '';
}

/**
 * A first sign-in waiting at the welcome page, through the API's dev-only stand-in for a
 * provider callback (the browser's own fetch, so it carries the Origin header and gets the cookie).
 */
export async function pendingSignup(page: Page, displayName: string): Promise<void> {
  await page.goto('/signin');
  const status = await page.evaluate(async (name) => {
    const res = await fetch('/api/dev/pending-signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
    return res.status;
  }, displayName);
  expect(status).toBe(201);
  await page.goto('/welcome');
}

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Fails with a readable list of violations (rule, impact, first targets). */
export async function expectAccessible(page: Page, what: string) {
  const result = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const summary = result.violations.map((v) => `${v.id} (${v.impact ?? '?'}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${what}\n${summary.join('\n')}`).toEqual([]);
}
