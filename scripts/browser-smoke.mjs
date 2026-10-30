// Optional browser integration test: all page requests are intercepted fixtures.
// Uses an isolated, headless Chrome. Does not access the user's browser profile.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserLogin } from '../src/browser.mjs';
import { CtyunSession, APP } from '../src/session.mjs';
import { fakePortal } from '../test/fixtures.mjs';
const fake = fakePortal();
let closed = false;
const wrapper = { launch: async options => {
  const browser = await chromium.launch({ ...options, headless: true });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async () => {
    const context = await newContext();
    await context.addCookies([
      { name: 'YL-Token', value: 'valid-app', domain: '.ctyun.cn', path: '/', secure: true },
      { name: 'token_iam', value: 'valid-iam', domain: '.ctyun.cn', path: '/', secure: true, httpOnly: true },
    ]);
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname === 'desk.ctyun.cn') return route.fulfill({ status: 302, headers: { location: APP + '/chat/' } });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Fixture signed in</body></html>' });
    });
    return context;
  };
  const close = browser.close.bind(browser);
  browser.close = async () => { closed = true; return close(); };
  return browser;
} };
const session = await browserLogin({ chromium: wrapper, timeout: 20_000,
  sessionFactory: () => new CtyunSession({ fetchImpl: fake.fetchImpl }) });
assert.equal((await session.models()).models.length, 3);
assert.match(await session.jar.getCookieString(APP), /token_iam=valid-iam/);
assert.equal(closed, true);
console.log(JSON.stringify({ browser: 'headless isolated Chrome', cookieCapture: 'ok', iamCookiePreserved: true, windowCleanup: true, network: 'fixtures only' }));
