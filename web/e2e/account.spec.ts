import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openDm, signedIn } from './helpers.js';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const send = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(log(page).locator('div.letter', { hasText: text }).locator('[data-tick]')).toHaveAttribute('data-tick', /sent|delivered|read/);
};

async function deleteAccount(page: Page, handle: string, erase: boolean) {
  await page.goto('/account');
  const form = page.getByRole('form', { name: 'Delete account' });
  await expect(form).toContainText('Your handle stays unavailable to anyone else for 30 days.');
  if (erase) await form.getByLabel(/Also erase every message I sent/).check();
  const button = form.getByRole('button', { name: 'Delete my account' });
  await expect(button).toBeDisabled(); // until the handle is typed
  await form.getByLabel(/Type your handle/).fill(handle);
  await expectAccessible(page, 'account deletion form');
  await button.click();
  await expect(page).toHaveURL(/\/signin\?deleted=1$/);
  await expect(page.getByRole('status')).toHaveText(/Your account was deleted/);
}

test('delete an account: letters stay for the other person, signed "Deleted user"', async ({ browser }) => {
  const a = await signedIn(browser, 'dlA');
  const b = await signedIn(browser, 'dlB');
  const dm = await openDm(a.page, b.handle);
  await send(a.page, 'a letter that stays');

  await deleteAccount(a.page, a.handle, false);
  await expectAccessible(a.page, 'sign-in after deletion');
  await a.page.goto('/');
  await expect(a.page).toHaveURL(/\/signin$/); // signed out

  await b.page.goto('/');
  await expect(b.page.getByRole('navigation', { name: 'Conversations' }).getByText('Deleted user')).toBeVisible();
  await b.page.goto(`/c/${dm}`);
  await expect(log(b.page).getByText('a letter that stays')).toBeVisible();
  await expect(b.page.getByText('This account was deleted. You can still read your letters.')).toBeVisible();
  await expect(composer(b.page)).toHaveCount(0);
  await a.context.close();
  await b.context.close();
});

test('delete an account and erase its messages: they become "message deleted" for everyone', async ({ browser }) => {
  const a = await signedIn(browser, 'erA');
  const b = await signedIn(browser, 'erB');
  const dm = await openDm(a.page, b.handle);
  await send(a.page, 'please forget this');
  await b.page.goto(`/c/${dm}`);
  await expect(log(b.page).getByText('please forget this')).toBeVisible();

  await deleteAccount(a.page, a.handle, true);
  // b's open chat gets the erasure pushed live (no reload).
  await expect(log(b.page).getByText('please forget this')).toHaveCount(0);
  await expect(log(b.page).getByText('message deleted')).toBeVisible();
  await a.context.close();
  await b.context.close();
});
