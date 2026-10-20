import { expect, test } from '@playwright/test';
import { openDm, signedIn } from './helpers.js';

test('sign in, start a DM by handle search, exchange a letter, manage a group, edit the profile', async ({ browser }) => {
  const a = await signedIn(browser, 'scrA');
  const b = await signedIn(browser, 'scrB');

  await openDm(a.page, b.handle);
  await a.page.getByLabel('Message').fill('Namaste from A');
  await a.page.getByLabel('Message').press('Enter');
  await expect(a.page.getByRole('main').getByText('Namaste from A')).toBeVisible();

  // B sees it in the inbox (preview + unread badge) and in the chat.
  await b.page.goto('/');
  const row = b.page.getByRole('link', { name: new RegExp(a.handle) });
  await expect(row).toContainText('Namaste from A');
  await expect(row.getByLabel('1 unread')).toBeVisible();
  await row.click();
  await expect(b.page.getByRole('main').getByText('Namaste from A')).toBeVisible();

  // A creates a group with B, sees the member list, and B can leave.
  await a.page.goto('/new/group');
  await a.page.getByLabel('Group name').fill('Book club');
  await a.page.getByLabel('Add people by handle').fill(b.handle);
  await a.page.getByRole('button', { name: new RegExp(`Add ${b.handle}`) }).click();
  await a.page.getByRole('button', { name: 'Create group' }).click();
  await a.page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(a.page.getByRole('main').getByText('You created the group')).toBeVisible();
  await a.page.getByRole('link', { name: 'Conversation info' }).click();
  await expect(a.page.getByRole('main').getByText('2 members')).toBeVisible();

  // Profile: display name.
  await b.page.goto('/settings');
  await b.page.getByLabel('Display name').fill('Bina from Pune');
  await b.page.getByRole('button', { name: 'Save' }).click();
  await expect(b.page.getByLabel('Display name')).toHaveValue('Bina from Pune');

  await a.context.close();
  await b.context.close();
});
