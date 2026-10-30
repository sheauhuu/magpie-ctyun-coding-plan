import { Cookie } from 'tough-cookie';
import { APP, ENTRY, CtyunError, CtyunSession } from './session.mjs';

export async function importBrowserCookies(session, cookies) {
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '');
    if (!(domain === 'ctyun.cn' || domain.endsWith('.ctyun.cn'))) continue;
    const cookie = new Cookie({ key: c.name, value: c.value, domain: c.domain.replace(/^\./, ''),
      path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly,
      hostOnly: !c.domain.startsWith('.'), sameSite: c.sameSite?.toLowerCase(),
      ...(c.expires > 0 ? { expires: new Date(c.expires * 1000) } : {}) });
    await session.jar.setCookie(cookie, `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`);
  }
}

// A fresh, dedicated browser context: no password manager data is imported or saved.
// It is closed in finally, including timeout and manual window-close paths.
export async function browserLogin({ state, deviceCode, chromium, timeout = 300_000, sessionFactory } = {}) {
  if (!chromium) {
    try { ({ chromium } = await import('playwright')); }
    catch { throw new CtyunError('浏览器登录组件未安装，请在插件目录运行 npm install 和 npm run browser:install', 'BROWSER'); }
  }
  let browser;
  try {
    // Prefer an installed Chrome binary, still with an isolated temporary
    // profile. Fall back to Playwright's Chromium when Chrome is unavailable.
    for (const options of [{ channel: 'chrome', headless: false }, { headless: false }]) {
      try { browser = await chromium.launch(options); break; } catch { /* Try the next installed browser. */ }
    }
    if (!browser) throw new CtyunError('无法启动专用登录窗口，请安装 Chrome 或在插件目录运行 npm run browser:install', 'BROWSER');
    const context = await browser.newContext();
    const initial = sessionFactory?.() || new CtyunSession({ state, deviceCode });
    const saved = initial.jar.serializeSync().cookies;
    if (saved.length) await context.addCookies(saved.map(c => ({ name: c.key, value: c.value,
      domain: c.hostOnly ? c.domain : `.${c.domain.replace(/^\./, '')}`, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(c.expires && c.expires !== 'Infinity' ? { expires: Date.parse(c.expires) / 1000 } : {}) })));
    const page = await context.newPage();
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!browser.isConnected() || page.isClosed()) throw new CtyunError('登录窗口已关闭', 'CANCELLED');
      if (new URL(page.url()).hostname === new URL(APP).hostname) {
        const session = sessionFactory?.() || new CtyunSession({ deviceCode: initial.deviceCode });
        await importBrowserCookies(session, await context.cookies());
        try {
          await session.models();
          return session;
        } catch (error) {
          if (error.code !== 'AUTH') throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new CtyunError('登录等待超时，请重新打开登录窗口', 'TIMEOUT');
  } catch (error) {
    if (error instanceof CtyunError) throw error;
    throw new CtyunError('浏览器登录未完成，请重新尝试', 'BROWSER');
  } finally { await browser?.close().catch(() => {}); }
}
