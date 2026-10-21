import { expect, test, type Page } from '@playwright/test';
import { openDm, signedIn } from './helpers.js';

/** Collects every CSP violation the page reports, from before any app code runs. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) => { seen.push(`${e.violatedDirective} ${e.blockedURI}`); });
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test('the production build ships a strict CSP and nothing in the app violates it', async ({ browser }) => {
  const a = await signedIn(browser, 'cspA');
  const b = await signedIn(browser, 'cspB');
  const violations = await watchCsp(a.page);
  await a.page.goto('/');
  const csp = await a.page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");

  const dm = await openDm(a.page, b.handle);
  await a.page.getByRole('textbox', { name: 'Message' }).fill('CSP check https://example.com');
  await a.page.getByRole('textbox', { name: 'Message' }).press('Enter');
  for (const path of [`/c/${dm}`, `/c/${dm}/info`, '/new', '/new/group', '/settings', '/account', '/signin?error=cancelled&provider=google']) {
    await a.page.goto(path);
    await a.page.waitForLoadState('networkidle');
    expect(await violations(), path).toEqual([]);
  }
  // A script smuggled into a message is text, and even an injected inline script would be refused.
  const blocked = await a.page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__ran = true';
    document.body.append(s);
    return (window as unknown as { __ran?: boolean }).__ran === true;
  });
  expect(blocked).toBe(false);
  await a.context.close();
  await b.context.close();
});
