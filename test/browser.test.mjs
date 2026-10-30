import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLogin, importBrowserCookies } from '../src/browser.mjs';
import { APP, CtyunSession } from '../src/session.mjs';

test('browser cookie import preserves parent-domain IAM cookies and filters unrelated sites', async () => {
  const s = new CtyunSession();
  await importBrowserCookies(s, [
    { name: 'token_iam', value: 'iam', domain: '.ctyun.cn', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: -1 },
    { name: 'YL-Token', value: 'app', domain: '.ctyun.cn', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: Date.now() / 1000 + 604800 },
    { name: 'unrelated', value: 'private', domain: '.example.org', path: '/', expires: -1 },
  ]);
  assert.match(await s.jar.getCookieString(APP), /token_iam=iam/);
  assert.equal(s.state().cookies.some(c => c.key === 'unrelated'), false);
  assert.ok(s.expires() > Date.now() + 6 * 86400_000);
});

test('browser login closes its window after verifying an authenticated portal response', async () => {
  let closed = false;
  let verified = false;
  const chromium = { launch: async () => ({ isConnected: () => true,
    close: async () => { closed = true; }, newContext: async () => ({
      cookies: async () => [], newPage: async () => ({ goto: async () => {}, url: () => `${APP}/chat/`, isClosed: () => false }),
    }),
  }) };
  const factory = () => { const s = new CtyunSession(); s.models = async () => { verified = true; return {}; }; return s; };
  const session = await browserLogin({ chromium, sessionFactory: factory });
  assert.ok(session instanceof CtyunSession);
  assert.equal(verified, true);
  assert.equal(closed, true);
});

test('manual browser close cancels login and cleans up', async () => {
  let cleaned = false;
  const chromium = { launch: async () => ({ isConnected: () => false,
    close: async () => { cleaned = true; }, newContext: async () => ({
      newPage: async () => ({ goto: async () => {}, isClosed: () => true }),
    }),
  }) };
  await assert.rejects(browserLogin({ chromium }), { code: 'CANCELLED' });
  assert.equal(cleaned, true);
});
