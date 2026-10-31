import test from 'node:test';
import assert from 'node:assert/strict';
import { modelId, adaptReasoning, reasoningConfig, modelCost, ReasoningSettingError } from '../src/model-profiles.mjs';
import { modelCatalog, BASE } from '../src/session.mjs';
import { createPlugin, PROVIDER } from '../src/plugin.mjs';

test('each exact model version declares only documented levels or switches', async () => {
  const plugin = await createPlugin({ client: {} });
  const config = {}; await plugin.config(config);
  const models = config.provider[PROVIDER].models;
  const expected = {
    'glm-5.3': ['low', 'high', 'max'], 'glm-5.3-flash': ['low', 'high', 'max'],
    'deepseek-v4.1-flash': ['none', 'low', 'high', 'max'],
    'deepseek-v4-flash-0731': ['none', 'low', 'high', 'max'],
    'deepseek-v4-pro-0813': ['none', 'low', 'high', 'max'],
    'glm-5.1': ['none', 'enabled'], 'kimi-k2.5': ['none', 'enabled'],
    'qwen-3.6-flash': ['none', 'enabled'], 'MiniMax-M2.5': ['enabled'],
  };
  assert.equal(Object.keys(models).length, 9);
  for (const [id, levels] of Object.entries(expected)) {
    assert.equal(models[id].reasoning, true);
    assert.deepEqual(Object.keys(models[id].variants), levels);
  }
  assert.deepEqual(reasoningConfig('glm-unknown'), {});
  assert.deepEqual(reasoningConfig('__proto__'), {});
});

test('all terminal -oc suffixes are removed without changing case, releases or other variants', () => {
  const ids = ['glm-5.1-oc', 'MiniMax-M2.5-oc', 'kimi-k2.5-oc', 'qwen-3.6-flash-oc',
    'deepseek-v4-pro-0813-oc', 'new-model-OC', 'oc-model', 'model-oc-preview'];
  const models = modelCatalog({ models: ids.map(model => ({ model, title: model, api: ['openai-completions'] })) });
  assert.deepEqual(Object.keys(models), ['glm-5.1', 'MiniMax-M2.5', 'kimi-k2.5', 'qwen-3.6-flash',
    'deepseek-v4-pro-0813', 'new-model', 'oc-model', 'model-oc-preview']);
  for (const id of ids) {
    assert.equal(models[modelId(id)].name, modelId(id));
    assert.deepEqual(reasoningConfig(modelId(id)), reasoningConfig(id));
    const effort = reasoningConfig(id).variants ? Object.keys(reasoningConfig(id).variants).at(-1) : undefined;
    const clean = adaptReasoning({ model: modelId(id), reasoning_effort: effort });
    const original = adaptReasoning({ model: id, reasoning_effort: effort });
    assert.deepEqual({ ...clean, model: id }, original);
  }
});

test('dynamic model discovery keeps normalized host metadata and new models get text defaults', () => {
  const previous = { 'glm-5.3': { api: { id: 'glm-5.3', url: BASE, npm: 'custom' },
    cost: { input: 7 }, limit: { context: 123 }, capabilities: { reasoning: false, toolcall: true, temperature: false } } };
  const catalog = modelCatalog({ models: ['glm-5.3-oc', 'brand-new'].map(model => ({ model, api: ['openai-completions'] })) }, previous);
  const glm = catalog['glm-5.3'];
  assert.equal(glm.name, 'GLM-5.3');
  assert.equal(catalog['glm-5.3-oc'], undefined);
  assert.deepEqual(glm.api, previous['glm-5.3'].api);
  assert.deepEqual(glm.limit, { context: 123 });
  assert.deepEqual(glm.cost, { input: 7 });
  assert.equal(glm.capabilities.reasoning, true);
  assert.equal(glm.capabilities.temperature, false);
  assert.equal(catalog['brand-new'].api.url, BASE);
  assert.equal(catalog['brand-new'].capabilities.reasoning, undefined);
  assert.equal(catalog['brand-new'].variants, undefined);
  assert.deepEqual(catalog['brand-new'].cost, { input: 0, output: 0 });
});

test('built-in models carry official list prices and discovery fills normalized costs', async () => {
  const plugin = await createPlugin({ client: {} });
  const config = {}; await plugin.config(config);
  const models = config.provider[PROVIDER].models;
  for (const [id, model] of Object.entries(models)) {
    assert.ok(model.cost?.input > 0 && model.cost.output > 0, id);
    assert.deepEqual(model.cost, modelCost(id));
  }
  assert.deepEqual(models['glm-5.3'].cost, { input: 1.4, output: 4.4, cache_read: 0.26 });
  assert.deepEqual(modelCost('MiniMax-M2.5-oc'), modelCost('MiniMax-M2.5'));
  assert.equal(modelCost('deepseek-v4-flash'), undefined);
  assert.equal(modelCost('__proto__'), undefined);
  const discovered = modelCatalog({ models: [{ model: 'qwen-3.6-flash-oc', api: ['openai-completions'] }] }, {});
  assert.deepEqual(discovered['qwen-3.6-flash'].cost, { input: 0.25, output: 1.5, cache: { read: 0.025, write: 0.3125 } });
});

test('GLM-5.3 keeps its routing ID and display name when the portal title is the upstream ID', () => {
  for (const upstream of ['glm-5.3-oc', 'glm-5.3']) {
    const models = modelCatalog({ models: [{ model: upstream, title: 'glm-5.3-oc', api: ['openai-completions'] }] });
    assert.deepEqual(Object.keys(models), ['glm-5.3']);
    assert.equal(models['glm-5.3'].name, 'GLM-5.3');
  }
});

test('graded controls retain native thinking priority and documented DeepSeek aliases', () => {
  for (const reasoning_effort of ['low', 'high', 'max']) {
    const body = { model: 'glm-5.3-oc', reasoning_effort, thinking: { budget_tokens: 123 } };
    assert.deepEqual(adaptReasoning(body).thinking, { type: 'enabled', budget_tokens: 123 });
    assert.deepEqual(body.thinking, { budget_tokens: 123 });
  }
  assert.throws(() => adaptReasoning({ model: 'glm-5.3-flash', reasoning_effort: 'none' }), ReasoningSettingError);
  for (const [effort, level] of [['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['ultra', 'max']]) {
    assert.equal(adaptReasoning({ model: 'deepseek-v4.1-flash', reasoning_effort: effort }).reasoning_effort, level);
  }
  const deep = reasoning_effort => ({ model: 'deepseek-v4.1-flash', reasoning_effort });
  assert.equal(adaptReasoning(deep('none')).thinking.type, 'disabled');
  assert.equal(adaptReasoning({ ...deep('none'), thinking: { type: 'enabled' } }).thinking.type, 'enabled');
  assert.equal(adaptReasoning({ ...deep('high'), thinking: { type: 'disabled' } }).thinking.type, 'disabled');
});

test('switches translate to native controls without fabricated effort or budget tiers', () => {
  for (const model of ['glm-5.1-oc', 'kimi-k2.5-oc']) {
    for (const [effort, type] of [['none', 'disabled'], ['enabled', 'enabled'], ['high', 'enabled']]) {
      const adapted = adaptReasoning({ model, reasoning_effort: effort, messages: [] });
      assert.deepEqual(adapted.thinking, { type });
      assert.equal(Object.hasOwn(adapted, 'reasoning_effort'), false);
    }
  }
  const qwen = adaptReasoning({ model: 'qwen-3.6-flash-oc', reasoning_effort: 'none', thinking_budget: 8192 });
  assert.equal(qwen.enable_thinking, false);
  assert.equal(qwen.thinking_budget, 8192);
  assert.equal(adaptReasoning({ ...qwen, reasoning_effort: 'high', enable_thinking: false }).enable_thinking, false);
  assert.deepEqual(adaptReasoning({ model: 'MiniMax-M2.5-oc', reasoning_effort: 'enabled' }), { model: 'MiniMax-M2.5-oc' });
  assert.throws(() => adaptReasoning({ model: 'MiniMax-M2.5-oc', reasoning_effort: 'none' }), ReasoningSettingError);
  const unknown = { model: 'new-model', reasoning_effort: 'anything', messages: [] };
  assert.equal(adaptReasoning(unknown), unknown);
  const defaults = { model: 'glm-5.3-oc', messages: [] };
  assert.equal(adaptReasoning(defaults), defaults);
});

test('loader translates both Chat endpoint forms and wraps SSE without leaking portal credentials', async () => {
  const sent = [];
  const plugin = await createPlugin({ client: {} }, { fetchImpl: async req => {
    sent.push({ body: await req.json(), headers: req.headers });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture' } });
  } });
  const loader = await plugin.auth.loader(async () => ({ access: 'fixture-key' }));
  for (const [publicId, upstream] of [
    ['MiniMax-M2.5', 'MiniMax-M2.5-oc'], ['glm-5.1', 'glm-5.1-oc'], ['kimi-k2.5', 'kimi-k2.5-oc'],
    ['qwen-3.6-flash', 'qwen-3.6-flash-oc'], ['deepseek-v4-flash-0731', 'deepseek-v4-flash-0731-oc'],
    ['deepseek-v4-pro-0813', 'deepseek-v4-pro-0813-oc'], ['glm-5.3-flash', 'glm-5.3-flash'],
    ['deepseek-v4.1-flash', 'deepseek-v4.1-flash'], ['unknown-model', 'unknown-model'],
  ]) {
    await loader.fetch(BASE + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: publicId }) });
    assert.equal(sent.at(-1).body.model, upstream);
  }
  for (const effort of [undefined, 'high']) {
    await loader.fetch(BASE + '/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'glm-5.3', reasoning_effort: effort }) });
    assert.equal(sent.at(-1).body.model, 'glm-5.3-oc');
    if (effort) assert.equal(sent.at(-1).body.thinking.type, 'enabled');
  }
  for (const path of ['/chat/completions', '/v1/chat/completions']) {
    const response = await loader.fetch(BASE + path, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'private-cookie', 'content-length': '0' },
      body: JSON.stringify({ model: 'kimi-k2.5-oc', reasoning_effort: 'none', messages: [] }) });
    assert.equal(await response.text(), 'data: [DONE]\n\n');
    assert.equal(response.headers.get('x-request-id'), 'fixture');
    assert.equal(sent.at(-1).body.thinking.type, 'disabled');
    assert.equal(sent.at(-1).headers.get('cookie'), null);
    assert.equal(sent.at(-1).headers.get('content-length'), null);
  }
  const before = sent.length;
  const invalid = await loader.fetch(BASE + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-oc', reasoning_effort: 'none' }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'unsupported_reasoning_setting');
  assert.equal(sent.length, before);
});

test('dynamic discovery remembers exact upstream IDs for new models and native unsuffixed IDs', async () => {
  const sent = [];
  const plugin = await createPlugin({ client: {} }, { credentials: {},
    sessionFactory: ({ state }) => ({ state: () => state, expires: () => Date.now() + 3_600_000,
      models: async () => ({ models: [
        { model: 'future-oc', title: 'Future-oc', api: ['openai-completions'] },
        { model: 'glm-5.1', api: ['openai-completions'] },
      ] }) }),
    fetchImpl: async req => { sent.push(await req.json()); return Response.json({}); } });
  const auth = { type: 'oauth', accountId: 'fixture', access: 'fixture-key', refresh: '{}', ctyun: { mode: 'browser' } };
  const models = await plugin.provider.models({ models: {} }, { auth });
  assert.deepEqual(Object.keys(models), ['future', 'glm-5.1']);
  const loader = await plugin.auth.loader(async () => auth);
  for (const model of ['future', 'glm-5.1']) {
    await loader.fetch(BASE + '/chat/completions', { method: 'POST', body: JSON.stringify({ model }) });
  }
  assert.deepEqual(sent.map(r => r.model), ['future-oc', 'glm-5.1']);
});

test('model mappings stay with their account and do not change API-key-only defaults', async () => {
  const sent = [];
  const plugin = await createPlugin({ client: {} }, { credentials: {},
    sessionFactory: ({ state }) => ({ state: () => state, expires: () => Date.now() + 3_600_000,
      models: async () => ({ models: state.ids.map(model => ({ model, api: ['openai-completions'] })) }) }),
    fetchImpl: async req => { sent.push(await req.json()); return Response.json({}); } });
  const auth = (accountId, ids) => ({ type: 'oauth', accountId, access: 'fixture-key-' + accountId,
    refresh: JSON.stringify({ ids }), ctyun: { mode: 'browser' } });
  const a = auth('a', ['future-oc']);
  const b = auth('b', ['future', 'glm-5.1']);
  await plugin.provider.models({ models: {} }, { auth: a });
  const loaderA = await plugin.auth.loader(async () => a);
  await plugin.provider.models({ models: {} }, { auth: b });
  const loaderB = await plugin.auth.loader(async () => b);
  const apiOnly = { ...a, refresh: '', ctyun: { mode: 'api-key' } };
  const loaderKey = await plugin.auth.loader(async () => apiOnly);
  for (const [loader, model] of [[loaderA, 'future'], [loaderB, 'future'], [loaderKey, 'glm-5.1']]) {
    await loader.fetch(BASE + '/chat/completions', { method: 'POST', body: JSON.stringify({ model }) });
  }
  assert.deepEqual(sent.map(r => r.model), ['future-oc', 'future', 'glm-5.1-oc']);
});
