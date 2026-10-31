// Actual MAGPIE host, fake sessions, private temporary auth storage only.
// Run with Bun: bun scripts/host-account-regression.mjs --host /path/to/host.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = process.argv.indexOf('--host');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('Pass --host /path/to/host.js; run with Bun');
const hostPath = resolve(process.argv[arg + 1]);
const folder = await mkdtemp(join(tmpdir(), 'magpie-account-regression-'));
const pluginURL = new URL('../src/plugin.mjs', import.meta.url).href;
const provider = 'ctyun-coding-plan';
const keys = [provider, provider + '#fixture-b', provider + '#fixture-c'];
const authPath = join(folder, 'plugin-auth.json');
const children = [];
const messages = [];
async function until(predicate) {
  const end = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Fixture gate timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}
const exists = async p => access(p).then(() => true, () => false);
async function start() {
  const child = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiting = new Map();
  let sequence = 0, buffer = '';
  child.stderr.resume(); // Never print host/plugin output, even on failure.
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const cut = buffer.indexOf('\n'); if (cut < 0) break;
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('Host RPC failed: ' + pending.method));
      else pending.resolve(message.result);
    }
  });
  child.on('exit', () => {
    for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(new Error('Host exited')); }
    waiting.clear();
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('RPC timeout: ' + method)); }, 15_000);
    waiting.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const loaded = await rpc('init', { authPath, directory: folder,
    plugins: [{ spec: folder, target: folder }] });
  assert.equal(loaded.plugins[0].error, undefined);
  return rpc;
}
const accounts = async () => Object.keys(JSON.parse(await readFile(authPath, 'utf8'))).sort();
const seed = async rpc => {
  for (const [i, key] of keys.entries()) await rpc('import', { provider, key, auth: {
    type: 'oauth', accountId: 'fixture-' + i, access: 'fixture-key-' + i,
    refresh: JSON.stringify({ generation: 0 }), expires: Date.now() + 3_600_000,
    ctyun: { mode: 'browser', deviceCode: 'fixture-device' },
  } });
};
try {
  await writeFile(join(folder, 'package.json'), JSON.stringify({ type: 'module', main: './index.mjs' }));
  await writeFile(join(folder, 'index.mjs'), `
import { createPlugin } from ${JSON.stringify(pluginURL)};
import fs from 'node:fs/promises';
const dir = ${JSON.stringify(folder)};
const exists = p => fs.access(dir + '/' + p).then(() => true, () => false);
async function gate(name) {
  if (!await exists(name + '.hold')) return;
  await fs.writeFile(dir + '/' + name + '.started', '');
  while (!await exists(name + '.release')) await new Promise(r => setTimeout(r, 5));
}
export default async input => {
  const set = input.client.auth.set;
  const client = { auth: { set: async opts => { await gate('save'); return set(opts); } } };
  const make = ({ state = {} } = {}) => ({
    deviceCode: 'fixture-device',
    state: () => ({ generation: (state.generation || 0) + 1 }),
    expires: () => Date.now() + 3_600_000,
    passwordLogin: async username => { if (username === 'reject') throw new Error('fixture login rejected'); },
    sso: async () => gate('refresh'),
    models: async () => { await gate('models'); return { models: [{ model: 'glm-5.3-oc', api: ['openai-completions'] }] }; },
    quota: async () => { await gate('quota'); if (await exists('quota.fail')) throw new Error('fixture failure'); return { windows: [{ name: 'fixture', used: 1 }] }; },
  });
  return createPlugin({ client }, { credentials: { set: async () => {}, remove: async () => {} },
    sessionFactory: make, browserLogin: async () => make() });
};
`);
  const a = await start(), b = await start();
  const signIn = async (method, extra = {}) => {
    const flow = await a('authorize', { provider, method,
      inputs: { account_name: 'fixture-0', api_key: 'fixture-key-0', ...extra } });
    return a('callback', { session: flow.session });
  };
  const apiOnly = await signIn(0);
  assert.equal(apiOnly.ok, true);
  assert.equal(apiOnly.account, keys[0]);
  let stored = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(stored[keys[0]].ctyun.mode, 'api-key');
  assert.equal(stored[keys[0]].expires, 0);
  assert.equal((await a('load', { provider, account: keys[0] })).apiKey, 'fixture-key-0');
  const apiUsage = await a('usage', { provider, account: keys[0] });
  assert.deepEqual(apiUsage.windows, []);
  assert.equal(apiUsage.error, '');
  assert.equal((await a('providers')).find(p => p.id === provider).models.length, 9);
  await b('import', { provider, key: keys[1], auth: { type: 'api', key: 'unrelated-fixture-key' } });
  stored = JSON.parse(await readFile(authPath, 'utf8'));
  const rejected = await signIn(2, { username: 'reject', password: 'fixture-password' });
  assert.equal(rejected.ok, false);
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), stored);
  for (const method of [2, 1]) {
    const upgraded = await signIn(method, { username: 'fixture-user', password: 'fixture-password' });
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.account, keys[0]);
    const after = JSON.parse(await readFile(authPath, 'utf8'));
    assert.deepEqual(Object.keys(after).sort(), keys.slice(0, 2).sort());
    assert.deepEqual(after[keys[1]], stored[keys[1]]);
    assert.equal(after[keys[0]].access, 'fixture-key-0');
    assert.equal(after[keys[0]].ctyun.mode, method === 2 ? 'password' : 'browser');
    assert.equal((await a('usage', { provider, account: keys[0] })).windows.length, 1);
  }
  messages.push({ scenario: 'API-key-only setup; failed upgrade keeps auth; password and browser upgrade preserve account key and sibling', result: 'pass' });
  const downgraded = await signIn(0);
  assert.equal(downgraded.account, keys[0]);
  const onlyAgain = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(onlyAgain[keys[0]].refresh, '');
  assert.equal(onlyAgain[keys[0]].ctyun.credentialRef, undefined);
  assert.equal((await a('usage', { provider, account: keys[0] })).windows.length, 0);
  const secondaryInputs = { account_name: 'fixture-secondary', api_key: 'fixture-secondary-key' };
  const secondary = await signIn(0, secondaryInputs);
  assert.ok(secondary.account.startsWith(provider + '#'));
  const otherAccounts = JSON.parse(await readFile(authPath, 'utf8'));
  const upgradedSecondary = await signIn(2, { ...secondaryInputs, username: 'fixture-user', password: 'fixture-password' });
  assert.equal(upgradedSecondary.account, secondary.account);
  const afterSecondary = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(afterSecondary[keys[0]], otherAccounts[keys[0]]);
  assert.deepEqual(afterSecondary[keys[1]], otherAccounts[keys[1]]);
  await b('signOut', { provider, account: secondary.account });
  messages.push({ scenario: 'switch back to API key; upgrade a suffixed account without moving its slot or changing siblings', result: 'pass' });
  await seed(a);
  for (const key of keys.slice(0, 2)) {
    await b('signOut', { provider, account: key });
    const ps = await a('providers');
    assert.deepEqual(ps.find(p => p.id === provider).accounts.map(a => a.key).sort(), await accounts());
  }
  assert.deepEqual(await accounts(), [keys[2]]);
  messages.push({ scenario: 'two hosts, sequential delete, exact account keys', result: 'pass' });

  await seed(a);
  // Hold the plugin's quota operation, then remove its exact key in the other host.
  await writeFile(join(folder, 'quota.hold'), '');
  const read = a('usage', { provider, account: keys[0] });
  await until(() => exists(join(folder, 'quota.started')));
  await b('signOut', { provider, account: keys[0] });
  await writeFile(join(folder, 'quota.release'), ''); await read;
  assert.deepEqual(await accounts(), keys.slice(1).sort());
  messages.push({ scenario: 'quota completes after delete', result: 'pass' });

  await seed(a);
  await rm(join(folder, 'quota.started')); await rm(join(folder, 'quota.release'));
  await writeFile(join(folder, 'quota.fail'), '');
  const failedRead = a('usage', { provider, account: keys[1] });
  await until(() => exists(join(folder, 'quota.started')));
  await b('signOut', { provider, account: keys[1] });
  await writeFile(join(folder, 'quota.release'), '');
  assert.ok((await failedRead).error);
  assert.deepEqual(await accounts(), [keys[0], keys[2]].sort());
  await rm(join(folder, 'quota.fail'));
  messages.push({ scenario: 'quota fails after suffixed account deletion', result: 'pass' });

  await seed(a);
  await writeFile(join(folder, 'save.hold'), '');
  const racing = a('usage', { provider, account: keys[0] });
  // A fixed plugin never calls auth.set. Wait for either the save gate or RPC completion.
  let finished = false;
  racing.then(() => { finished = true; }, () => { finished = true; });
  await until(async () => finished || await exists(join(folder, 'save.started')));
  await b('signOut', { provider, account: keys[0] });
  await writeFile(join(folder, 'save.release'), ''); await racing;
  const afterA = await accounts();
  await b('signOut', { provider, account: keys[1] });
  const afterB = await accounts();
  messages.push({ scenario: 'delete between getAuth check and auth.set; then delete second account',
    afterFirst: afterA, afterSecond: afterB,
    result: afterB.includes(keys[0]) ? 'RESURRECTED' : 'pass' });
  assert.deepEqual(afterB, [keys[2]], 'Deleted first account was restored by late auth.set');

  await seed(a);
  // Snapshot-based models and host-owned native refresh must also respect deletion.
  for (const hook of ['models', 'refresh']) {
    if (hook === 'refresh') await a('import', { provider, key: keys[0], auth: {
      type: 'oauth', accountId: 'fixture-0', access: 'fixture-key-0',
      refresh: '{"generation":0}', expires: 1, ctyun: { mode: 'browser' },
    } });
    await writeFile(join(folder, hook + '.hold'), '');
    const running = a(hook === 'models' ? 'providers' : 'load', { provider, account: keys[0] });
    await until(() => exists(join(folder, hook + '.started')));
    await b('signOut', { provider, account: keys[0] });
    await writeFile(join(folder, hook + '.release'), ''); await running;
    assert.deepEqual(await accounts(), keys.slice(1).sort());
    messages.push({ scenario: hook + ' completes after delete', result: 'pass' });
    await seed(a);
  }
} catch (error) {
  process.exitCode = 1;
  messages.push({ error: error.message });
} finally {
  for (const child of children) { child.stdin.end(); child.kill(); }
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(r => child.once('exit', r))));
  await rm(folder, { recursive: true, force: true });
  console.log(JSON.stringify({ host: hostPath, evidence: messages }, null, 2));
}
