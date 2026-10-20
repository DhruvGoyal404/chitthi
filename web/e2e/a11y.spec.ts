import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openDm, signedIn } from './helpers.js';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Fails with a readable list of violations (rule, impact, first targets). */
async function expectAccessible(page: Page, what: string) {
  const result = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const summary = result.violations.map((v) => `${v.id} (${v.impact ?? '?'}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${what}\n${summary.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`every screen meets WCAG 2.1 AA (${scheme})`, async ({ browser, page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/signin');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page, 'sign in');

    const a = await signedIn(browser, 'axA', { colorScheme: scheme });
    const b = await signedIn(browser, 'axB', { colorScheme: scheme });
    const dm = await openDm(a.page, b.handle);
    const say = async (p: Page, text: string) => {
      await p.getByRole('textbox', { name: 'Message' }).fill(text);
      await p.getByRole('textbox', { name: 'Message' }).press('Enter');
    };
    await say(a.page, 'Namaste! Recipe: https://example.com/aloo-paratha');
    await b.page.goto(`/c/${dm}`);
    await say(b.page, 'Thank you!');
    await say(a.page, 'Call me after 7?');

    // Inbox (B has an unread letter from A).
    await b.page.goto('/');
    await expect(b.page.getByRole('link', { name: new RegExp(a.handle) })).toBeVisible();
    await expectAccessible(b.page, 'inbox');

    // Chat: own and others' letters, ticks/postmark, a link, the composer.
    await a.page.goto(`/c/${dm}`);
    await expect(a.page.getByRole('log', { name: 'Messages' }).getByText('Call me after 7?')).toBeVisible();
    await expectAccessible(a.page, 'chat');
    await a.page.getByRole('log', { name: 'Messages' }).locator('div.letter', { hasText: 'Call me after 7?' })
      .getByRole('button', { name: 'Message options' }).click();
    await expect(a.page.getByRole('menu', { name: 'Message options' })).toBeVisible();
    await expectAccessible(a.page, 'chat with message menu');
    await a.page.keyboard.press('Escape');

    // New DM search, and a new group with a chosen member.
    await a.page.goto('/new');
    await a.page.getByLabel('Find someone by handle').fill(b.handle.slice(0, 5));
    await expect(a.page.getByRole('button', { name: new RegExp(b.handle) })).toBeVisible();
    await expectAccessible(a.page, 'new conversation');
    await a.page.goto('/new/group');
    await a.page.getByLabel('Group name').fill('Axe club');
    await a.page.getByLabel('Add people by handle').fill(b.handle);
    await a.page.getByRole('button', { name: new RegExp(`Add ${b.handle}`) }).click();
    await expectAccessible(a.page, 'new group');
    await a.page.getByRole('button', { name: 'Create group' }).click();
    await a.page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
    const group = a.page.url().split('/c/')[1] ?? '';
    await say(a.page, 'Hello group');

    // Group info and message info.
    await a.page.goto(`/c/${group}/info`);
    await expect(a.page.getByRole('main').getByText('2 members')).toBeVisible();
    await expectAccessible(a.page, 'conversation info');
    await a.page.goto(`/c/${group}`);
    await a.page.getByRole('log', { name: 'Messages' }).locator('div.letter', { hasText: 'Hello group' })
      .getByRole('button', { name: 'Message options' }).click();
    await a.page.getByRole('menuitem', { name: 'Message info' }).click();
    await expect(a.page.getByRole('heading', { name: 'Message info' })).toBeVisible();
    await expectAccessible(a.page, 'message info');

    // Settings.
    await a.page.goto('/settings');
    await expect(a.page.getByLabel('Display name')).toBeVisible();
    await expectAccessible(a.page, 'settings');

    await a.context.close();
    await b.context.close();
  });
}
