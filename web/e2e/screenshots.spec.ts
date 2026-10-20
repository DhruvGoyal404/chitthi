import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

// Documentation screenshots (docs/img). Opt-in: SCREENSHOTS=1 npm run e2e -w web -- e2e/screenshots.spec.ts
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/img');

const OUT = fileURLToPath(new URL('../../docs/img/', import.meta.url));
const ORIGIN = 'http://localhost:5175';

type Person = { page: Page; req: APIRequestContext; id: string; handle: string };

async function person(browser: Browser, first: string, displayName: string, colorScheme: 'light' | 'dark', viewport: { width: number; height: number }): Promise<Person> {
  const context = await browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  const handle = `${first}_${randomBytes(2).toString('hex')}`;
  const req = page.request;
  const res = await req.post('/api/dev/login', { data: { handle }, headers: { Origin: ORIGIN } });
  const { user } = (await res.json()) as { user: { id: string } };
  await req.patch('/api/me', { data: { displayName }, headers: { Origin: ORIGIN } });
  return { page, req, id: user.id, handle };
}
const post = async <T>(p: Person, path: string, data: object): Promise<T> =>
  (await (await p.req.post(`/api${path}`, { data, headers: { Origin: ORIGIN } })).json()) as T;
const say = async (p: Person, conv: string, body: string) =>
  (await post<{ message: { id: string; seq: number } }>(p, `/conversations/${conv}/messages`, { clientMsgId: randomUUID(), body })).message;

for (const [label, viewport] of [['390', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screenshots ${label} ${scheme}`, async ({ browser }) => {
      const suffix = `${label}${scheme === 'dark' ? '-dark' : ''}`;
      const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}${name}-${suffix}.png` });

      const asha = await person(browser, 'asha', 'Asha Rao', scheme, viewport);
      const ravi = await person(browser, 'ravi', 'Ravi Kumar', scheme, viewport);
      const meera = await person(browser, 'meera', 'Meera Iyer', scheme, viewport);

      const { conversation: dm } = await post<{ conversation: { id: string } }>(asha, '/conversations/direct', { userId: ravi.id });
      await say(asha, dm.id, 'Namaste Ravi! Did the parcel reach you?');
      await say(ravi, dm.id, 'Yes, this morning. Thank you 🙏');
      const recipe = await say(asha, dm.id, 'Wonderful. The recipe: https://example.com/recipes/aloo-paratha');
      const oops = await say(asha, dm.id, 'Call me after 6?');
      await asha.req.patch(`/api/conversations/${dm.id}/messages/${oops.id}`, { data: { body: 'Call me after 7?' }, headers: { Origin: ORIGIN } });
      const wrong = await say(ravi, dm.id, 'Sent to the wrong chat, sorry');
      await ravi.req.delete(`/api/conversations/${dm.id}/messages/${wrong.id}`, { headers: { Origin: ORIGIN } });
      await post(ravi, `/conversations/${dm.id}/read`, { seq: recipe.seq });

      const { conversation: trip } = await post<{ conversation: { id: string } }>(asha, '/conversations', { title: 'Weekend trip', memberIds: [ravi.id, meera.id] });
      await say(meera, trip.id, 'Train tickets are booked for Saturday 🚆');
      await say(ravi, trip.id, 'I will bring the snacks.');
      const plan = await say(asha, trip.id, 'Perfect. Meet at platform 4 at 8:15.');
      await post(meera, `/conversations/${trip.id}/read`, { seq: plan.seq });

      // Sign-in (a fresh, signed-out page).
      const anon = await browser.newContext({ colorScheme: scheme, viewport });
      const signin = await anon.newPage();
      await signin.goto('/signin');
      await expect(signin.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await shot(signin, 'signin');
      await anon.close();

      // Asha's inbox, the DM, the group, message info, group info, new chat, settings.
      await asha.page.goto('/');
      await expect(asha.page.getByRole('link', { name: /Weekend trip/ })).toBeVisible();
      await shot(asha.page, 'inbox');

      await asha.page.goto(`/c/${dm.id}`);
      await expect(asha.page.getByRole('log', { name: 'Messages' }).getByText('Call me after 7?')).toBeVisible();
      await asha.page.waitForTimeout(600);
      await shot(asha.page, 'chat');

      await ravi.page.goto(`/c/${dm.id}`);
      await expect(ravi.page.getByRole('log', { name: 'Messages' }).getByText('Call me after 7?')).toBeVisible();
      await ravi.page.waitForTimeout(400);

      await asha.page.goto(`/c/${trip.id}`);
      await expect(asha.page.getByRole('log', { name: 'Messages' }).getByText('platform 4')).toBeVisible();
      await asha.page.getByRole('textbox', { name: 'Message' }).fill('Should we book');
      await asha.page.waitForTimeout(600);
      await shot(asha.page, 'group');

      await asha.page.goto(`/c/${trip.id}/m/${plan.id}`);
      await expect(asha.page.getByRole('heading', { name: 'Message info' })).toBeVisible();
      await expect(asha.page.getByText('Read by')).toBeVisible();
      await shot(asha.page, 'message-info');

      await asha.page.goto(`/c/${trip.id}/info`);
      await expect(asha.page.getByRole('main').getByText('3 members')).toBeVisible();
      await shot(asha.page, 'group-info');

      await asha.page.goto('/new');
      await asha.page.getByLabel('Find someone by handle').fill('meera');
      await expect(asha.page.getByRole('button', { name: new RegExp(meera.handle) })).toBeVisible();
      await shot(asha.page, 'new-chat');

      await asha.page.goto('/settings');
      await expect(asha.page.getByLabel('Display name')).toHaveValue('Asha Rao');
      await shot(asha.page, 'settings');

      for (const p of [asha, ravi, meera]) await p.page.context().close();
    });
  }
}
