import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openDm, signedIn } from './helpers.js';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const send = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
};

test('block from contact info, both sides stop messaging, unblock from the account page', async ({ browser }) => {
  const a = await signedIn(browser, 'bkA');
  const b = await signedIn(browser, 'bkB');
  const dm = await openDm(a.page, b.handle);
  await send(a.page, 'hello before');
  await b.page.goto(`/c/${dm}`);
  await expect(log(b.page).getByText('hello before')).toBeVisible();

  // a blocks b, after a confirmation that says what it does.
  await a.page.goto(`/c/${dm}/info`);
  await a.page.getByRole('button', { name: `Block ${b.handle}` }).click();
  const confirm = a.page.getByRole('group', { name: `Block ${b.handle}?` });
  await expect(confirm).toContainText('Groups you already share stay as they are.');
  await expectAccessible(a.page, 'block confirmation');
  await confirm.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(a.page.getByText(`You blocked ${b.handle}.`)).toBeVisible();

  await a.page.goto(`/c/${dm}`);
  await expect(a.page.getByText('You blocked this person. Unblock them in contact info to send messages.')).toBeVisible();
  await expect(composer(a.page)).toHaveCount(0);

  // b's open chat: the send is refused for good (no retry offered), and after a reload the
  // composer explains instead.
  await send(b.page, 'are you there?');
  const refused = log(b.page).locator('div.letter', { hasText: 'are you there?' });
  await expect(refused.getByRole('alert')).toHaveText("You can't message this person.");
  await expect(refused.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await b.page.reload();
  await expect(b.page.getByText("You can't message this person.").first()).toBeVisible();
  await expect(log(b.page).getByText('hello before')).toBeVisible(); // history stays

  // Unblock from the account page; messages flow again.
  await a.page.goto('/account');
  const row = a.page.getByRole('listitem').filter({ hasText: `@${b.handle}` });
  await expect(row).toBeVisible();
  await expectAccessible(a.page, 'account with a blocked person');
  await row.getByRole('button', { name: /Unblock/ }).click();
  await expect(a.page.getByText("You haven't blocked anyone.")).toBeVisible();
  await a.page.goto(`/c/${dm}`);
  await send(a.page, 'hello after');
  await b.page.reload();
  await expect(log(b.page).getByText('hello after')).toBeVisible();
  await a.context.close();
  await b.context.close();
});
