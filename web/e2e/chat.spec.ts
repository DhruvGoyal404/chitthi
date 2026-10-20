import { expect, test, type Page } from '@playwright/test';
import { openDm, signedIn } from './helpers.js';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const send = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
};
/** The tick state of my bubble containing `text`. */
const tickOf = (page: Page, text: string) =>
  log(page).locator('div.letter', { hasText: text }).locator('[data-tick]');

test.describe.configure({ mode: 'serial' });

test('ticks go sent → delivered → read as the recipient receives and then views', async ({ browser }) => {
  const a = await signedIn(browser, 'tkA');
  const b = await signedIn(browser, 'tkB');
  // B is not connected while A sends: the message is stored, not delivered.
  await b.page.goto('about:blank');
  const id = await openDm(a.page, b.handle);
  await send(a.page, 'Will you get this?');
  await expect(tickOf(a.page, 'Will you get this?')).toHaveAttribute('data-tick', 'sent');

  // B comes online on the inbox (not viewing the chat): delivered, not read.
  await b.page.goto('/');
  await expect(tickOf(a.page, 'Will you get this?')).toHaveAttribute('data-tick', 'delivered');
  await expect(tickOf(a.page, 'Will you get this?')).toHaveAccessibleName('Delivered');

  // B opens the conversation and sees it: read.
  await b.page.goto(`/c/${id}`);
  await expect(log(b.page).getByText('Will you get this?')).toBeVisible();
  await expect(tickOf(a.page, 'Will you get this?')).toHaveAttribute('data-tick', 'read');
  await expect(tickOf(a.page, 'Will you get this?')).toHaveAccessibleName('Read');

  await a.context.close();
  await b.context.close();
});

test('an offline recipient gets exactly the missed messages, in order, when back online', async ({ browser }) => {
  const a = await signedIn(browser, 'offA');
  const b = await signedIn(browser, 'offB');
  const id = await openDm(a.page, b.handle);
  await send(a.page, 'before the outage');
  await b.page.goto(`/c/${id}`);
  await expect(log(b.page).getByText('before the outage')).toBeVisible();

  await b.context.setOffline(true);
  await expect(b.page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  const missed = ['one', 'two', 'three', 'four', 'five'].map((n) => `missed ${n}`);
  for (const text of missed) {
    await send(a.page, text);
    await expect(tickOf(a.page, text)).toHaveAttribute('data-tick', /sent|delivered|read/);
  }
  await expect(log(b.page).getByText('missed one')).toHaveCount(0);

  await b.context.setOffline(false);
  for (const text of missed) await expect(log(b.page).getByText(text, { exact: true })).toHaveCount(1);
  const bodies = await log(b.page).locator('div.letter p.whitespace-pre-wrap').allInnerTexts();
  expect(bodies).toEqual(['before the outage', ...missed]); // exactly these, in order, no duplicates
  await expect(b.page.locator('[data-connection="live"]')).toHaveCount(1);

  await a.context.close();
  await b.context.close();
});

test('edits and deletes propagate; a deleted message shows as deleted everywhere', async ({ browser }) => {
  const a = await signedIn(browser, 'edA');
  const b = await signedIn(browser, 'edB');
  const id = await openDm(a.page, b.handle);
  await b.page.goto(`/c/${id}`);
  await send(a.page, 'see you at 6');
  await expect(log(b.page).getByText('see you at 6')).toBeVisible();

  const bubble = log(a.page).locator('div.letter', { hasText: 'see you at 6' });
  await bubble.getByRole('button', { name: 'Message options' }).click();
  await a.page.getByRole('menuitem', { name: 'Edit' }).click();
  await composer(a.page).fill('see you at 7');
  await composer(a.page).press('Enter');
  await expect(log(b.page).getByText('see you at 7')).toBeVisible();
  await expect(log(b.page).locator('div.letter', { hasText: 'see you at 7' }).getByText('edited')).toBeVisible();

  await log(a.page).locator('div.letter', { hasText: 'see you at 7' }).getByRole('button', { name: 'Message options' }).click();
  await a.page.getByRole('menuitem', { name: 'Delete…' }).click();
  await a.page.getByRole('menuitem', { name: 'Delete for everyone' }).click();
  await expect(log(b.page).getByText('message deleted')).toBeVisible();
  await expect(log(b.page).getByText('see you at 7')).toHaveCount(0);
  await expect(log(a.page).getByText('message deleted')).toBeVisible();

  await a.context.close();
  await b.context.close();
});

test('hostile message text renders inert: no script, no handler, no javascript: links', async ({ browser }) => {
  const a = await signedIn(browser, 'xsA');
  const b = await signedIn(browser, 'xsB');
  const id = await openDm(a.page, b.handle);
  await b.page.goto(`/c/${id}`);
  const payloads = [
    '<script>window.__pwned = "script"</script>',
    '<img src=x onerror="window.__pwned = \'img\'">',
    'javascript:window.__pwned="link" and [click](javascript:alert(1))',
    '<a href="javascript:alert(1)">tap</a> and https://example.com/ok?a=1&b=<2>',
  ];
  for (const p of payloads) await send(a.page, p);
  for (const p of payloads.slice(0, 3)) await expect(log(b.page).getByText(p, { exact: true })).toBeVisible(); // shown as text

  for (const page of [a.page, b.page]) {
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
    await expect(log(page).locator('img, script, iframe')).toHaveCount(0);
    const hrefs = await log(page).locator('a').evaluateAll((as) => as.map((x) => ({ href: x.getAttribute('href'), rel: x.getAttribute('rel') })));
    // The URL ends where "<" begins; "<2>" stays plain text after the link.
    expect(hrefs).toEqual([{ href: 'https://example.com/ok?a=1&b=', rel: 'noopener noreferrer' }]);
    await expect(log(page).getByText(/<2>/)).toBeVisible();
  }

  await a.context.close();
  await b.context.close();
});
