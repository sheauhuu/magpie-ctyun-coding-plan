import { APP, IAM, ENTRY } from '../src/session.mjs';

export const models = { models: [
  { model: 'deepseek-v4.1-flash', title: 'DeepSeek-V4.1-Flash', api: ['openai-completions'] },
  { model: 'MiniMax-M2.5-oc', title: 'MiniMax-M2.5', api: ['openai-completions'] },
  { model: 'anthropic-only', title: 'Other', api: ['anthropic-messages'] },
] };
export function quotaFixture(now = Date.now()) {
  return { plan: { id: 'plan-1', state: '已购买', name: 'Coding Plan Lite',
    effTime: new Date(now - 86400_000).toISOString(), expTime: new Date(now + 29 * 86400_000).toISOString() },
  detail: { updateTime: now, usages: [
    { period: '套餐总量', usage: .012, tips: '29天后刷新限额' },
    { period: '近5小时', usage: .008, tips: '39分后刷新限额' },
    { period: '本周', usage: .001, tips: '2天1时37分后刷新限额' },
  ] } };
}
export function fakePortal() {
  const calls = { password: 0, ticket: 0, sso: 0, inference: 0 };
  let reject = false;
  let challenge = null;
  let network = false;
  const json = (payload, status = 200, cookies = []) => new Response(JSON.stringify(payload), {
    status, headers: [['Content-Type', 'application/json'], ...cookies.map(c => ['Set-Cookie', c])],
  });
  const redirect = url => new Response(null, { status: 302, headers: { Location: url } });
  const fetchImpl = async (address, init) => {
    if (network) throw new Error('private network error token=DO_NOT_LOG');
    const url = new URL(address instanceof Request ? address.url : address);
    const headers = new Headers(init?.headers);
    const cookie = headers.get('cookie') || '';
    if (url.href === ENTRY) {
      calls.sso++;
      return cookie.includes('token_iam=valid-iam') ? redirect(`${APP}/chat/#/aichat?ticket=test-ticket`) : redirect(`${IAM}?consent=false`);
    }
    if (url.href.startsWith(`${IAM}?`)) return new Response('<html>login</html>');
    if (url.pathname === '/chat/') return new Response('<html>app</html>');
    if (url.href === `${IAM}api/auth/iam/login`) {
      calls.password++;
      if (challenge === 'captcha') return json({ code: 51040 });
      if (challenge === 'sms') return json({ code: 0, data: { needSmsValidate: 1 } });
      if (reject) return json({ code: 51001 });
      return json({ code: 0, data: { returnUrl: ENTRY } }, 200, ['token_iam=valid-iam; Domain=.ctyun.cn; Path=/; Secure; HttpOnly']);
    }
    if (url.pathname === '/sso/login/v2/iam/ticketAuthorize') {
      calls.ticket++;
      if (new URLSearchParams(init.body).get('iamTicket') !== 'test-ticket') throw new Error('wrong ticket');
      return json({ resultCode: 0, data: {} }, 200, [
        'YL-Token=valid-app; Domain=.ctyun.cn; Path=/; Max-Age=604800; Secure',
        'YL-Ssid=valid-ssid; Domain=.ctyun.cn; Path=/; Max-Age=604800; Secure',
      ]);
    }
    if (url.pathname.startsWith('/ai/portal/')) {
      if (!cookie.includes('YL-Token=valid-app')) return json({ resultCode: 401 }, 401);
      const fixture = quotaFixture();
      if (url.pathname.endsWith('/model/apiAccess')) return json({ resultCode: 0, data: models });
      if (url.pathname.endsWith('/usage/summry')) return json({ resultCode: 0, data: { paid: [fixture.plan] } });
      if (url.pathname.endsWith('/usage/detail')) return json({ resultCode: 0, data: fixture.detail });
    }
    throw new Error(`Unexpected fixture URL path: ${url.pathname}`);
  };
  return { fetchImpl, calls, setChallenge: c => { challenge = c; }, rejectLogin: () => { reject = true; },
    failNetwork: () => { network = true; }, restoreNetwork: () => { network = false; } };
}
export class MemoryCredentials {
  entries = new Map();
  async set(id, value) { this.entries.set(id, structuredClone(value)); }
  async get(id) { return this.entries.get(id) || null; }
  async remove(id) { this.entries.delete(id); }
}
