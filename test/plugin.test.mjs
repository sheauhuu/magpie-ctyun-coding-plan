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
  const action = await f.plugin.auth.methods[2].authorize(inputs);
  const result = await action.callback();
  assert.equal(result.type, 'success');
  f.setAuth({ ...result, type: 'oauth' });
  return { inputs, result };
}

test('API-key-only setup, listing, usage and refresh never open a portal or credential store', async () => {
  let auth, request;
  const unexpected = () => { throw new Error('API-key-only must not access portal or credentials'); };
  const plugin = await createPlugin({ client: {} }, { sessionFactory: unexpected, browserLogin: unexpected,
    credentials: new Proxy({}, { get: unexpected }),
    fetchImpl: async req => { request = req; return Response.json({ id: 'fixture-response' }); } });
  const method = plugin.auth.methods[0];
  assert.deepEqual(method.prompts.map(p => p.key), ['account_name', 'api_key']);
  const action = await method.authorize({ account_name: ' fixture ', api_key: ' fixture-key ' });
  const result = await action.callback();
  assert.equal(result.type, 'success');
  auth = { ...result, type: 'oauth' };
  assert.equal(auth.accountId, 'fixture');
  assert.equal(auth.refresh, '');
  assert.equal(auth.expires, 0);
  assert.equal(auth.ctyun.mode, 'api-key');
  const config = {}; await plugin.config(config);
  const models = config.provider[PROVIDER].models;
  assert.equal(await plugin.provider.models({ models }, { auth }), models);
  assert.equal(Object.keys(models).length, 9);
  const quota = await plugin.auth.usage(async () => auth);
  assert.deepEqual(quota.windows, []);
  assert.equal(quota.error, undefined);
  assert.equal(quota.signIn, 'kept');
  assert.equal(await plugin.auth.refresh(auth), undefined);
  const loader = await plugin.auth.loader(async () => auth);
  await loader.fetch(BASE + '/chat/completions', { method: 'POST', body: '{"model":"glm-5.3"}' });
  assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
  assert.equal((await request.json()).model, 'glm-5.3-oc');
});

test('API-key-only setup validates required inputs without starting login', async () => {
  const f = await fixture();
  for (const inputs of [{ account_name: '', api_key: 'key' }, { account_name: 'fixture', api_key: '' }]) {
    const action = await f.plugin.auth.methods[0].authorize(inputs);
    assert.equal((await action.callback()).type, 'failed');
  }
  assert.equal(f.fake.calls.password, 0);
  assert.equal(f.credentials.entries.size, 0);
});

test('an existing loader does not reuse the API key after account removal', async () => {
  let auth = { access: 'fixture-key' }, calls = 0;
  const plugin = await createPlugin({ client: {} }, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const loader = await plugin.auth.loader(async () => auth);
  auth = undefined;
  await assert.rejects(loader.fetch(BASE + '/chat/completions', { method: 'POST', body: '{}' }), AuthError);
  assert.equal(calls, 0);
});

test('password mode stores credentials only in the credential store, not returned auth', async () => {
  const f = await fixture();
  const { result, inputs } = await login(f);
  assert.equal(inputs.password, '');
  assert.equal(JSON.stringify(result).includes('test-password'), false);
  assert.equal((await f.credentials.get(result.ctyun.credentialRef)).password, 'test-password');
  assert.equal((await f.plugin.auth.usage(f.getAuth)).windows.length, 3);
});

test('concurrent quota reads renew once in memory and native refresh returns the new cookie jar', async () => {
  const f = await fixture(); await login(f);
  const auth = await f.getAuth();
  const broken = f.make({ state: JSON.parse(auth.refresh), deviceCode: auth.ctyun.deviceCode });
  for (const c of broken.jar.getCookiesSync(APP)) if (c.key.startsWith('YL-')) await broken.jar.store.removeCookie(c.domain, c.path, c.key);
  f.setAuth({ ...auth, refresh: JSON.stringify(broken.state()) });
  const stored = await f.getAuth();
  const ticketBefore = f.fake.calls.ticket;
  const result = await Promise.all(Array.from({ length: 4 }, () => f.plugin.auth.usage(f.getAuth)));
  assert.ok(result.every(r => r.windows.length === 3));
  assert.equal(f.fake.calls.ticket - ticketBefore, 1);
  assert.equal(f.fake.calls.password, 1);
  assert.deepEqual(await f.getAuth(), stored);
  const patch = await f.plugin.auth.refresh(stored);
  assert.notEqual(patch.refresh, stored.refresh);
  assert.deepEqual(await f.getAuth(), stored);
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
  const action = await plugin.auth.methods[1].authorize({ account_name: 'test-account', api_key: 'test-api-key' });
  const next = await action.callback();
  assert.equal(next.ctyun.mode, 'browser');
  assert.equal(next.ctyun.credentialRef, undefined);
  assert.equal(await f.credentials.get(result.ctyun.credentialRef), null);
  assert.equal(JSON.stringify(next).includes('test-password'), false);
});

test('failed password login does not write credentials or leak password via error', async () => {
  const f = await fixture(); f.fake.setChallenge('captcha');
  const inputs = { account_name: 'test', api_key: 'key', username: 'user', password: 'secret-example' };
  const action = await f.plugin.auth.methods[2].authorize(inputs);
  const result = await action.callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /验证码/);
  assert.equal(result.error.includes('secret-example'), false);
  assert.equal(f.credentials.entries.size, 0);
  assert.equal(inputs.password, '');
});

test('two accounts do not share cookies or password references', async () => {
  const fake = fakePortal();
  const credentials = new MemoryCredentials();
  const make = options => new CtyunSession({ ...options, fetchImpl: fake.fetchImpl });
  const s = make(); await s.passwordLogin('user-a', 'password');
  let a = { ...savedAuth(s, { account_name: 'a', api_key: 'a-key' }, 'browser'), type: 'oauth' };
  const empty = make();
  let b = { ...savedAuth(empty, { account_name: 'b', api_key: 'b-key' }, 'browser'), type: 'oauth' };
  const manager = new SessionManager({ sessionFactory: make, credentials });
  await manager.run(async () => a, x => x.models());
  await assert.rejects(manager.run(async () => b, x => x.models()), AuthError);
  assert.equal(manager.latest.size, 2);
  const failed = [...manager.latest.values()].find(v => v.auth.accountId === 'b').auth;
  assert.equal(failed.ctyun.reauthRequired, true);
  assert.equal(a.ctyun.reauthRequired, undefined);
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

test('quota success and failure keep auth storage unchanged; errors remain in the session cache', async () => {
  const f = await fixture(); await login(f);
  const before = await f.getAuth();
  assert.equal((await f.plugin.auth.usage(f.getAuth)).windows.length, 3);
  assert.deepEqual(await f.getAuth(), before);
  f.setAuth({ ...before, refresh: JSON.stringify(f.make().state()) });
  f.fake.rejectLogin();
  const broken = await f.getAuth();
  assert.ok((await f.plugin.auth.usage(f.getAuth)).error);
  assert.deepEqual(await f.getAuth(), broken);
  const attempts = f.fake.calls.password;
  assert.ok((await f.plugin.auth.usage(f.getAuth)).error);
  assert.equal(f.fake.calls.password, attempts);
});

test('a quota read finishing after account removal does not restore the account', async () => {
  for (const fails of [false, true]) {
    const f = await fixture(); await login(f);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const manager = new SessionManager({ sessionFactory: f.make, credentials: f.credentials });
    const pending = manager.run(f.getAuth, async () => {
      started(); await gate;
      if (fails) throw new AuthError();
      return 'ok';
    });
    await ready;
    f.setAuth(undefined);
    release();
    if (fails) await assert.rejects(pending, AuthError); else await pending;
    assert.equal(await f.getAuth(), undefined);
  }
});

test('model discovery does not persist its account snapshot', async () => {
  const f = await fixture(); await login(f);
  const auth = await f.getAuth();
  const broken = f.make({ state: JSON.parse(auth.refresh), deviceCode: auth.ctyun.deviceCode });
  for (const c of broken.jar.getCookiesSync(APP)) if (c.key.startsWith('YL-')) await broken.jar.store.removeCookie(c.domain, c.path, c.key);
  const snapshot = { ...auth, refresh: JSON.stringify(broken.state()) };
  f.setAuth(undefined);
  const config = {}; await f.plugin.config(config);
  const models = await f.plugin.provider.models(config.provider[PROVIDER], { auth: snapshot });
  assert.ok(Object.keys(models).length);
  assert.equal(await f.getAuth(), undefined);
});
