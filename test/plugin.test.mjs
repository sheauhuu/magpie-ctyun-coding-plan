import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin, PROVIDER, SessionManager, savedAuth } from '../src/plugin.mjs';
import { CtyunSession, APP, BASE, AuthError } from '../src/session.mjs';
import { fakePortal, MemoryCredentials } from './fixtures.mjs';

async function fixture() {
  const fake = fakePortal();
  const credentials = new MemoryCredentials();
  let auth;
  const client = { auth: { set: async ({ path, body }) => { assert.equal(path.id, PROVIDER); auth = structuredClone(body); } } };
  const make = options => new CtyunSession({ ...options, fetchImpl: fake.fetchImpl });
  const plugin = await createPlugin({ client }, { credentials, sessionFactory: make });
  return { fake, credentials, client, make, plugin, getAuth: async () => auth,
    setAuth: value => { auth = structuredClone(value); } };
}
async function login(f) {
  const inputs = { account_name: 'test-account', api_key: 'test-api-key', plan_id: '', username: 'test-user', password: 'test-password' };
  const action = await f.plugin.auth.methods[1].authorize(inputs);
  const result = await action.callback();
  assert.equal(result.type, 'success');
  f.setAuth({ ...result, type: 'oauth' });
  return { inputs, result };
}

test('password mode stores credentials only in the credential store, not returned auth', async () => {
  const f = await fixture();
  const { result, inputs } = await login(f);
  assert.equal(inputs.password, '');
  assert.equal(JSON.stringify(result).includes('test-password'), false);
  assert.equal((await f.credentials.get(result.ctyun.credentialRef)).password, 'test-password');
  assert.equal((await f.plugin.auth.usage(f.getAuth)).windows.length, 3);
});

test('concurrent quota reads renew only once and persist the new cookie jar', async () => {
  const f = await fixture(); await login(f);
  const auth = await f.getAuth();
  const broken = f.make({ state: JSON.parse(auth.refresh), deviceCode: auth.ctyun.deviceCode });
  for (const c of broken.jar.getCookiesSync(APP)) if (c.key.startsWith('YL-')) await broken.jar.store.removeCookie(c.domain, c.path, c.key);
  f.setAuth({ ...auth, refresh: JSON.stringify(broken.state()) });
  const ticketBefore = f.fake.calls.ticket;
  const result = await Promise.all(Array.from({ length: 4 }, () => f.plugin.auth.usage(f.getAuth)));
  assert.ok(result.every(r => r.windows.length === 3));
  assert.equal(f.fake.calls.ticket - ticketBefore, 1);
  assert.equal(f.fake.calls.password, 1);
});

test('loss of all sessions falls back to the password in the system store', async () => {
  const f = await fixture(); await login(f);
  const auth = await f.getAuth();
  f.setAuth({ ...auth, refresh: JSON.stringify(f.make().state()) });
  const result = await f.plugin.auth.usage(f.getAuth);
  assert.equal(result.windows.length, 3);
  assert.equal(f.fake.calls.password, 2);
});

test('rejected saved password stops automatic retries while inference still works', async () => {
  const f = await fixture(); await login(f);
  const auth = await f.getAuth();
  f.setAuth({ ...auth, refresh: JSON.stringify(f.make().state()) });
  f.fake.rejectLogin();
  const first = await f.plugin.auth.usage(f.getAuth);
  const attempts = f.fake.calls.password;
  const second = await f.plugin.auth.usage(f.getAuth);
  assert.equal(first.signIn, 'kept');
  assert.equal(first.windows.length, 0);
  assert.equal(second.windows.length, 0);
  assert.equal(f.fake.calls.password, attempts);
  const loader = await f.plugin.auth.loader(f.getAuth);
  assert.equal(loader.apiKey, 'test-api-key');
});

test('inference sends only the API key, strips cookies and refuses foreign URLs', async () => {
  const f = await fixture(); await login(f);
  let request;
  const plugin = await createPlugin({ client: f.client }, { credentials: f.credentials,
    sessionFactory: f.make, fetchImpl: async req => { request = req; return new Response('data: done\n\n'); } });
  const loader = await plugin.auth.loader(f.getAuth);
  await loader.fetch(`${BASE}/chat/completions`, { method: 'POST', body: '{}',
    headers: { Cookie: 'private-cookie', 'YL-Authorization': 'private-session', Authorization: 'wrong' } });
  assert.equal(request.headers.get('authorization'), 'Bearer test-api-key');
  assert.equal(request.headers.get('cookie'), null);
  assert.equal(request.headers.get('yl-authorization'), null);
  assert.equal(request.redirect, 'manual');
  await assert.rejects(loader.fetch('https://attacker.invalid/chat', {}), { code: 'ORIGIN' });
});

test('browser mode saves cookies without passwords and removes the old password entry', async () => {
  const f = await fixture();
  const { result } = await login(f);
  const session = f.make({ state: JSON.parse(result.refresh) });
  const plugin = await createPlugin({ client: f.client }, { credentials: f.credentials, sessionFactory: f.make,
    browserLogin: async () => session });
  const action = await plugin.auth.methods[0].authorize({ account_name: 'test-account', api_key: 'test-api-key' });
  const next = await action.callback();
  assert.equal(next.ctyun.mode, 'browser');
  assert.equal(next.ctyun.credentialRef, undefined);
  assert.equal(await f.credentials.get(result.ctyun.credentialRef), null);
  assert.equal(JSON.stringify(next).includes('test-password'), false);
});

test('failed password login does not write credentials or leak password via error', async () => {
  const f = await fixture(); f.fake.setChallenge('captcha');
  const inputs = { account_name: 'test', api_key: 'key', username: 'user', password: 'secret-example' };
  const action = await f.plugin.auth.methods[1].authorize(inputs);
  const result = await action.callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /验证码/);
  assert.equal(result.error.includes('secret-example'), false);
  assert.equal(f.credentials.entries.size, 0);
  assert.equal(inputs.password, '');
});

test('two accounts do not share cookies or password references', async () => {
  const fake = fakePortal(); const saved = [];
  const credentials = new MemoryCredentials();
  const make = options => new CtyunSession({ ...options, fetchImpl: fake.fetchImpl });
  const s = make(); await s.passwordLogin('user-a', 'password');
  let a = { ...savedAuth(s, { account_name: 'a', api_key: 'a-key' }, 'browser'), type: 'oauth' };
  const empty = make();
  let b = { ...savedAuth(empty, { account_name: 'b', api_key: 'b-key' }, 'browser'), type: 'oauth' };
  const manager = new SessionManager({ sessionFactory: make, credentials, persist: async v => saved.push(v) });
  await manager.run(async () => a, x => x.models());
  await assert.rejects(manager.run(async () => b, x => x.models()), AuthError);
  assert.equal(saved.at(-1).accountId, 'b');
  assert.equal(saved.at(-1).ctyun.reauthRequired, true);
});

test('native refresh returns a patch for the host without writing auth storage itself', async () => {
  const f = await fixture(); await login(f);
  const before = structuredClone(await f.getAuth());
  const patch = await f.plugin.auth.refresh(before);
  assert.equal(patch.ctyun.portalError, '');
  assert.equal(patch.ctyun.reauthRequired, false);
  assert.deepEqual(await f.getAuth(), before);
  assert.ok(JSON.parse(patch.refresh).cookies.length > 0);
});
