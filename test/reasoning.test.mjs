import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptReasoning, reasoningConfig, ReasoningSettingError } from '../src/model-profiles.mjs';
import { modelCatalog, BASE } from '../src/session.mjs';
import { createPlugin, PROVIDER } from '../src/plugin.mjs';

test('each exact model version declares only documented levels or switches', async () => {
  const plugin = await createPlugin({ client: {} });
  const config = {}; await plugin.config(config);
  const models = config.provider[PROVIDER].models;
  const expected = {
    'glm-5.3-oc': ['low', 'high', 'max'], 'glm-5.3-flash': ['low', 'high', 'max'],
    'deepseek-v4.1-flash': ['none', 'low', 'high', 'max'],
    'deepseek-v4-flash-0731-oc': ['none', 'low', 'high', 'max'],
    'deepseek-v4-pro-0813-oc': ['none', 'low', 'high', 'max'],
    'glm-5.1-oc': ['none', 'enabled'], 'kimi-k2.5-oc': ['none', 'enabled'],
    'qwen-3.6-flash-oc': ['none', 'enabled'], 'MiniMax-M2.5-oc': ['enabled'],
  };
  assert.equal(Object.keys(models).length, 9);
  for (const [id, levels] of Object.entries(expected)) {
    assert.equal(models[id].reasoning, true);
    assert.deepEqual(Object.keys(models[id].variants), levels);
  }
  assert.deepEqual(reasoningConfig('glm-unknown'), {});
  assert.deepEqual(reasoningConfig('__proto__'), {});
});

test('dynamic model discovery keeps normalized host metadata and new models get text defaults', () => {
  const previous = { 'glm-5.3-oc': { api: { id: 'glm-5.3-oc', url: BASE, npm: 'custom' },
    cost: { input: 7 }, limit: { context: 123 }, capabilities: { reasoning: false, toolcall: true, temperature: false } } };
  const catalog = modelCatalog({ models: ['glm-5.3-oc', 'brand-new'].map(model => ({ model, api: ['openai-completions'] })) }, previous);
  const glm = catalog['glm-5.3-oc'];
  assert.deepEqual(glm.api, previous['glm-5.3-oc'].api);
  assert.deepEqual(glm.limit, { context: 123 });
  assert.deepEqual(glm.cost, { input: 7 });
  assert.equal(glm.capabilities.reasoning, true);
  assert.equal(glm.capabilities.temperature, false);
  assert.equal(catalog['brand-new'].api.url, BASE);
  assert.equal(catalog['brand-new'].capabilities.reasoning, undefined);
  assert.equal(catalog['brand-new'].variants, undefined);
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
