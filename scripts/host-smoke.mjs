// Load this plugin in MAGPIE's actual Bun host, with an empty temporary auth store.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const index = process.argv.indexOf('--host');
if (index < 0 || !process.argv[index + 1]) throw new Error('Pass --host /path/to/magpie/internal/plugin/host.js; run with Bun');
const folder = await mkdtemp(join(tmpdir(), 'magpie-ctyun-host-'));
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const child = spawn(process.execPath, [resolve(process.argv[index + 1])], { stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
let sequence = 0, buffer = '';
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const cut = buffer.indexOf('\n'); if (cut < 0) break;
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const pending = waiting.get(message.id);
    if (!pending) continue;
    waiting.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Host RPC timeout')); }, 30_000);
  waiting.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
try {
  const loaded = await rpc('init', { authPath: join(folder, 'plugin-auth.json'), directory: folder,
    plugins: [{ spec: repo, target: repo }] });
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].error, undefined);
  const providers = await rpc('providers', {});
  assert.ok(JSON.stringify(providers).includes('ctyun-coding-plan'));
  assert.ok(JSON.stringify(providers).includes('deepseek-v4.1-flash'));
  assert.ok(JSON.stringify(providers).includes('MiniMax-M2.5'));
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const findProvider = value => {
    if (!value || typeof value !== 'object') return undefined;
    if (value.id === 'ctyun-coding-plan') return value;
    for (const child of Object.values(value)) { const found = findProvider(child); if (found) return found; }
  };
  const provider = findProvider(providers);
  assert.ok(provider.models.every(m => !/-oc$/i.test(m.id) && !/-oc$/i.test(m.name) && !/-oc$/i.test(m.apiId)));
  assert.equal(provider?.name, '天翼云 Coding Plan');
  assert.equal(provider.methods.length, 3);
  assert.equal(provider.methods[0].label, '仅 API Key（不查询额度）');
  assert.equal(provider.methods[2].label, '账号密码登录');
  assert.equal(provider.icon, manifest.magpie.icon);
  assert.ok(provider.icon.startsWith('data:image/x-icon;base64,'));
  const findModel = (value, id) => {
    if (!value || typeof value !== 'object') return undefined;
    if (value.id === id && Array.isArray(value.variants)) return value;
    for (const child of Object.values(value)) { const found = findModel(child, id); if (found) return found; }
  };
  for (const [id, levels] of [
    ['glm-5.3', ['low', 'high', 'max']],
    ['deepseek-v4.1-flash', ['none', 'low', 'high', 'max']],
    ['kimi-k2.5', ['none', 'enabled']],
    ['qwen-3.6-flash', ['none', 'enabled']],
    ['MiniMax-M2.5', ['enabled']],
  ]) {
    const model = findModel(providers, id);
    assert.equal(model?.reasoning, true, id);
    assert.deepEqual(model.variants, levels, id);
  }
  const first = await rpc('prompt', { provider: 'ctyun-coding-plan', method: 0, inputs: {} });
  assert.equal(first.prompt.key, 'account_name');
  const secret = await rpc('prompt', { provider: 'ctyun-coding-plan', method: 2, inputs: { account_name: 'fixture' } });
  assert.equal(secret.prompt.key, 'api_key');
  assert.equal(secret.prompt.type, 'password');
  const answered = { account_name: 'fixture', api_key: 'fixture-key', plan_id: '', username: 'fixture-user' };
  const save = await rpc('prompt', { provider: 'ctyun-coding-plan', method: 2, inputs: answered });
  assert.equal(save.prompt.key, 'save_password');
  assert.equal(save.prompt.type, 'select');
  assert.deepEqual(save.prompt.options.map(o => o.value), ['no', 'yes']);
  const password = await rpc('prompt', { provider: 'ctyun-coding-plan', method: 2, inputs: { ...answered, save_password: 'no' } });
  assert.equal(password.prompt.key, 'password');
  assert.equal(password.prompt.type, 'password');
  console.log(JSON.stringify({ magpieHostLoad: 'ok', provider: 'ctyun-coding-plan', displayName: provider.name, icon: 'embedded official favicon', loginMethods: 3, secretPrompt: 'masked', reasoningVariants: 'ok' }));
} finally {
  child.stdin.end(); child.kill();
  for (const item of waiting.values()) clearTimeout(item.timer);
  await rm(folder, { recursive: true, force: true });
}
