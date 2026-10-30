import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CtyunSession, APP, ENTRY, AuthError, allowedURL, modelCatalog, quotaWindows, parseChinaTime, hintSeconds } from '../src/session.mjs';
import { fakePortal, models, quotaFixture } from './fixtures.mjs';

test('password login uses the official SHA256 transform and acquires app cookies', async () => {
  const fake = fakePortal();
  let posted;
  const s = new CtyunSession({ fetchImpl: async (url, init) => {
    if (url.endsWith('/iam/login')) posted = JSON.parse(init.body);
    return fake.fetchImpl(url, init);
  }, deviceCode: 'iam:stable-device' });
  await s.passwordLogin('account', 'test-password');
  assert.equal(posted.password, createHash('sha256').update('test-password').digest('hex'));
  assert.equal(posted.deviceCode, 'iam:stable-device');
  assert.equal(Object.keys(modelCatalog(await s.models())).length, 2);
  assert.ok(s.expires() > Date.now() + 6 * 86400_000);
});

test('missing app cookies cause 401, IAM session restores them without another password', async () => {
  const fake = fakePortal();
  const s = new CtyunSession({ fetchImpl: fake.fetchImpl });
  await s.passwordLogin('account', 'password');
  for (const c of s.jar.getCookiesSync(APP)) if (c.key.startsWith('YL-')) await s.jar.store.removeCookie(c.domain, c.path, c.key);
  await assert.rejects(s.models(), AuthError);
  await s.sso();
  assert.equal((await s.quota()).windows.length, 3);
  assert.equal(fake.calls.password, 1);
});

test('captcha and SMS requirements stop password login without retries', async () => {
  for (const kind of ['captcha', 'sms']) {
    const fake = fakePortal(); fake.setChallenge(kind);
    const s = new CtyunSession({ fetchImpl: fake.fetchImpl });
    await assert.rejects(s.passwordLogin('account', 'password'), { code: kind });
    assert.equal(fake.calls.password, 1);
    assert.equal(fake.calls.ticket, 0);
  }
});

test('redirect allowlist blocks credential-bearing requests to a different website', async () => {
  let count = 0;
  const s = new CtyunSession({ fetchImpl: async () => {
    count++;
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/collect' } });
  } });
  await assert.rejects(s.request(ENTRY), { code: 'ORIGIN' });
  assert.equal(count, 1);
  for (const u of ['http://desk.ctyun.cn/', 'https://desk.ctyun.cn:8810/', 'https://user:pass@desk.ctyun.cn/']) {
    assert.throws(() => allowedURL(u), { code: 'ORIGIN' });
  }
});

test('quota periods are matched by name, use percentages, and preserve actual plan expiry', () => {
  const { plan, detail } = quotaFixture(Date.parse('2026-10-30T14:00:00Z'));
  const q = quotaWindows(plan, detail);
  assert.equal(q.windows.find(w => w.name === '5 hours').used, .8);
  assert.equal(q.windows.find(w => w.name === 'Weekly').used, .1);
  assert.equal(q.windows.find(w => w.name === 'Plan total').used, 1.2);
  assert.equal(q.windows.find(w => w.name === 'Plan total').resetsAt, plan.expTime);
  assert.equal(hintSeconds('2天1时37分后刷新限额'), 178620);
  assert.equal(parseChinaTime('2026-11-21 19:02:16'), Date.parse('2026-11-21T11:02:16Z'));
  assert.equal(hintSeconds('未知'), null);
});

test('missing or invalid usage is an error, never fabricated zero quota', () => {
  const { plan, detail } = quotaFixture();
  detail.usages[0].usage = null;
  assert.throws(() => quotaWindows(plan, detail));
  detail.usages.pop();
  assert.throws(() => quotaWindows(plan, detail));
});

test('catalog keeps exact case and -oc IDs, excludes unsupported protocols', () => {
  const result = modelCatalog(models);
  assert.ok(result['MiniMax-M2.5-oc']);
  assert.equal(result['anthropic-only'], undefined);
  assert.equal(result['MiniMax-M2.5'], undefined);
});

test('transport failures never expose underlying exceptions with secret values', async () => {
  const fake = fakePortal(); fake.failNetwork();
  const s = new CtyunSession({ fetchImpl: fake.fetchImpl });
  await assert.rejects(s.models(), error => error.code === 'NETWORK' && !error.message.includes('DO_NOT_LOG'));
});

test('discard invalid upstream cookie domains while retaining valid cookies, as browsers do', async () => {
  const s = new CtyunSession({ fetchImpl: async () => new Response('{}', { headers: [
    ['Set-Cookie', 'YL-Ssid=invalid; Domain=172.24.0.163; Path=/; Secure'],
    ['Set-Cookie', 'YL-Token=valid; Domain=.ctyun.cn; Path=/; Secure'],
  ] }) });
  await s.request(APP);
  assert.equal(await s.jar.getCookieString(APP), 'YL-Token=valid');
});
