import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openDm, signedIn } from './helpers.js';

// A real 96×64 PNG (made with sharp), so the server's re-encoding has something to work on.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAwElEQVR4nO3ZwQnDQADEQNekIlLxFZh/IP6EsH4MXAVCK5/t67xyzncIFzrnVhGAAqhfVsKgAIpB/e9RY2IBFIMysVYXWg0KoBiUiaVBPfO7gkgHUAzKxNKg5j0W6QCKQZlY8+64KAZQDMrEmgfIy2oAxaBMLA1qHmORDqAYlIk1j46LYgDFoEyshxx/VgMoBmViaVDzHot0AMWgTKx5d1wUAygGZWLNA+RlNYBiUCaWBjWPsUgHUAzKxJpH5+O8AQS0IaUPr5yiAAAAAElFTkSuQmCC',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n% train tickets\n');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const picker = (page: Page) => page.getByTestId('file-picker');
const tray = (page: Page) => page.getByRole('list', { name: 'Attachments to send' });

/** Collects CSP violations from before any app code runs. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) => { seen.push(`${e.violatedDirective} ${e.blockedURI}`); });
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test('a photo and a file: preview, send, placeholder → thumbnail → lightbox, download', async ({ browser }) => {
  const a = await signedIn(browser, 'mdA');
  const b = await signedIn(browser, 'mdB');
  const violations = await watchCsp(a.page);
  const dm = await openDm(a.page, b.handle);

  await picker(a.page).setInputFiles([
    { name: 'chai.png', mimeType: 'image/png', buffer: PNG },
    { name: 'tickets.pdf', mimeType: 'application/pdf', buffer: PDF },
  ]);
  await expect(tray(a.page).getByRole('listitem')).toHaveCount(2);
  await expect(tray(a.page).locator('img[src^="blob:"]')).toHaveCount(1); // the photo's local preview (decorative: alt="")
  await composer(a.page).fill('for the trip');
  await composer(a.page).press('Enter');
  await expect(tray(a.page)).toHaveCount(0);
  await expect(log(a.page).getByRole('button', { name: 'Open photo chai.png' })).toBeVisible();
  await expect(log(a.page).getByText('for the trip')).toBeVisible();
  expect(await violations()).toEqual([]); // blob: previews, data: placeholders and thumbnails all within the CSP

  await b.page.goto('/');
  await expect(b.page.getByRole('navigation', { name: 'Conversations' }).getByText('2 attachments: for the trip')).toBeVisible();
  await b.page.goto(`/c/${dm}`);
  const photo = log(b.page).getByRole('button', { name: 'Open photo chai.png' });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await photo.click();
  const dialog = b.page.getByRole('dialog', { name: 'chai.png' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.getByRole('img', { name: 'chai.png' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96);
  await expectAccessible(b.page, 'photo lightbox');
  await b.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const download = b.page.waitForEvent('download');
  await log(b.page).getByRole('link', { name: 'Download tickets.pdf' }).click();
  expect((await download).suggestedFilename()).toBe('tickets.pdf');
  await expectAccessible(b.page, 'chat with attachments');
  await a.context.close();
  await b.context.close();
});

test('drag-and-drop and paste attach files; checks before upload are calm', async ({ browser }) => {
  const a = await signedIn(browser, 'ddA');
  const b = await signedIn(browser, 'ddB');
  await openDm(a.page, b.handle);

  const dropped = await a.page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['packing list: chai, maps'], 'list.txt', { type: 'text/plain' }));
    return dt;
  });
  const chat = a.page.getByRole('region', { name: /^Conversation with/ });
  await chat.dispatchEvent('dragover', { dataTransfer: dropped });
  await chat.dispatchEvent('drop', { dataTransfer: dropped });
  await expect(tray(a.page).getByText('list.txt')).toBeVisible();

  await composer(a.page).focus();
  await a.page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    document.getElementById('composer')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await expect(tray(a.page).getByText('screenshot.png')).toBeVisible();
  await tray(a.page).getByRole('button', { name: 'Remove list.txt' }).click();
  await expect(tray(a.page).getByRole('listitem')).toHaveCount(1);
  await composer(a.page).press('Enter');
  await expect(log(a.page).getByRole('button', { name: 'Open photo screenshot.png' })).toBeVisible();

  await picker(a.page).setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
  await expect(a.page.getByRole('alert')).toHaveText('huge.png is too large. Photos can be up to 10 MB.');
  await expect(tray(a.page)).toHaveCount(0);
  await a.context.close();
  await b.context.close();
});

test('an upload can be cancelled, a failed one retried, and a refused one discarded', async ({ browser }) => {
  const a = await signedIn(browser, 'crA');
  const b = await signedIn(browser, 'crB');
  await openDm(a.page, b.handle);
  const sendFile = async (name: string, buffer: Buffer, mimeType: string) => {
    await picker(a.page).setInputFiles({ name, mimeType, buffer });
    await composer(a.page).press('Enter');
  };

  // Cancel: the upload never finishes, the sender gives up.
  await a.page.route('**/api/uploads', () => { /* hold it forever */ });
  await sendFile('slow.pdf', PDF, 'application/pdf');
  const slow = log(a.page).locator('div.letter', { hasText: 'slow.pdf' });
  await expect(slow.getByRole('progressbar', { name: 'Uploading slow.pdf' })).toBeVisible();
  await slow.getByRole('button', { name: 'Cancel' }).click();
  await expect(slow).toHaveCount(0);
  await a.page.unroute('**/api/uploads');

  // Retry: the storage is briefly unavailable, then the same letter goes through once.
  await a.page.route('**/api/uploads', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'storage_unavailable', message: "Couldn't save the file. Try again in a moment." } }) }));
  await sendFile('retry.pdf', PDF, 'application/pdf');
  const failed = log(a.page).locator('div.letter', { hasText: 'retry.pdf' });
  await expect(failed.getByRole('alert')).toHaveText("retry.pdf: Couldn't save the file. Try again in a moment.");
  await a.page.unroute('**/api/uploads');
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(log(a.page).getByRole('link', { name: 'Download retry.pdf' })).toHaveCount(1);
  await expect(log(a.page).getByRole('alert')).toHaveCount(0);

  // Refused for good: HTML dressed as a PNG. No retry; the sender can discard it.
  await sendFile('cat.png', Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/png');
  const refused = log(a.page).locator('div.letter', { hasText: 'cat.png' });
  await expect(refused.getByRole('alert')).toContainText('cat.png: Chitthi takes photos');
  await expect(refused.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await refused.getByRole('button', { name: 'Discard' }).click();
  await expect(refused).toHaveCount(0);
  await a.context.close();
  await b.context.close();
});
