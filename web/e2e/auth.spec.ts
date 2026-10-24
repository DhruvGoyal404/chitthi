import { expect, test } from '@playwright/test';
import { handle, pendingSignup, signedIn } from './helpers.js';

test('first sign-in: pick a handle on the welcome page, then sign out everywhere', async ({ browser, page }) => {
  await pendingSignup(page, 'Asha Rao');
  await expect(page.getByRole('heading', { name: 'Welcome to Chitthi' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('Asha Rao');
  await expect(page.getByLabel('Pick a handle')).not.toHaveValue(''); // a free handle is suggested

  await page.getByLabel('Pick a handle').fill('Admin');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('That handle is reserved')).toBeVisible();

  const mine = handle('wel');
  await page.getByLabel('Pick a handle').fill(mine);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByLabel('Handle')).toHaveValue(mine);

  // The welcome page is single-use.
  await page.goto('/welcome');
  await expect(page).toHaveURL(/\/$/); // signed in: sent home

  // Sign out everywhere also ends the other browser's session.
  const other = await signedIn(browser, 'soe');
  const otherHandle = other.handle;
  await other.page.goto('/settings');
  await other.page.getByRole('link', { name: 'Account and sign-in' }).click();
  await expect(other.page.getByRole('heading', { name: 'Sign-in methods' })).toBeVisible();
  const twin = await other.context.browser()?.newContext();
  const twinPage = await twin?.newPage();
  if (!twin || !twinPage) throw new Error('no second context');
  await twinPage.goto('/signin');
  await twinPage.getByLabel('Your handle').fill(otherHandle);
  await twinPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(twinPage.getByRole('navigation', { name: 'Conversations' })).toBeVisible();

  await other.page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(other.page).toHaveURL(/\/signin$/);
  await twinPage.reload();
  await expect(twinPage).toHaveURL(/\/signin$/);
  await twin.close();
  await other.context.close();
});

test('sign-in errors from a provider round trip read calmly', async ({ page }) => {
  await page.goto('/signin?error=account_exists&provider=google');
  await expect(page.getByRole('alert')).toHaveText(/An account already uses this email\. Sign in the way you did before, then link Google/);
  await page.goto('/welcome');
  await expect(page.getByRole('alert')).toHaveText(/expired or was already used/);
  await page.getByRole('link', { name: 'Back to sign-in' }).click();
  await expect(page).toHaveURL(/\/signin$/);
});

test('privacy and terms are public, linked from sign-in, and say the plain facts', async ({ page }) => {
  await page.goto('/signin');
  await page.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('the server, and anyone with access to its database, can read every message');
  await expect(page.getByRole('main')).toContainText('Database copies are deleted after 35 days');
  await expect(page.getByRole('link', { name: 'privacy@dhruvgoyal.tech' })).toHaveAttribute('href', 'mailto:privacy@dhruvgoyal.tech');
  await page.getByRole('link', { name: 'Terms' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible();
  // A deep link works too: the static server answers with the app shell.
  await page.goto('/terms');
  await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible();
});
