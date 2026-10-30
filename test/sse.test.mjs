import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeSSE } from '../src/sse.mjs';

const encoder = new TextEncoder();
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, extra = {}) => ({ id: 'chatcmpl-real', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta }], ...extra });
const empty = chunk({ role: 'assistant', content: '' }, { id: '' });
const response = body => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
function bytes(text, size = 1) {
  const data = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= data.length) { controller.close(); return; }
    controller.enqueue(data.slice(offset, offset + size)); offset += size;
  } });
}
function events(text) {
  return text.replace(/\r\n|\r/g, '\n').split('\n\n').flatMap(block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

test('initial empty ID placeholder is removed across every UTF-8 and line-ending boundary', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const input = (event(empty) + event(chunk({ content: '你好 🌏', reasoning_content: '保留推理' })) + 'data: [DONE]\n\n').replaceAll('\n', eol);
    const output = await normalizeSSE(response(bytes(input))).text();
    assert.equal(events(output).length, 1);
    assert.equal(events(output)[0].id, 'chatcmpl-real');
    assert.equal(events(output)[0].choices[0].delta.content, '你好 🌏');
    assert.equal(events(output)[0].choices[0].delta.reasoning_content, '保留推理');
    assert.ok(output.endsWith(`data: [DONE]${eol}${eol}`));
  }
});

test('empty-ID frames with any payload or unknown fields survive, as do later empty frames', async () => {
  const meaningful = [chunk({ content: 'text' }, { id: '' }), chunk({ reasoning_content: 'thought' }, { id: '' }),
    chunk({ tool_calls: [{ index: 0, id: '', type: '' }] }, { id: '' }),
    { ...empty, usage: { total_tokens: 1 } }, { ...empty, extra_metadata: true },
    { ...empty, error: { message: 'failure' } },
    { ...empty, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }];
  for (const value of meaningful) assert.equal(await normalizeSSE(response(event(value))).text(), event(value));
  const later = event(chunk({ content: 'first' })) + event(empty);
  assert.equal(await normalizeSSE(response(later)).text(), later);
});

test('only known function continuations lose empty type/id; all indices and argument bytes remain', async () => {
  const tool = (index, id, type, args, name = '') => ({ index, id, type, function: { name, arguments: args } });
  const first = chunk({ tool_calls: [tool(0, 'call-a', 'function', '', 'lookup'), tool(1, 'call-b', 'function', '', 'other')] });
  const continued = chunk({ tool_calls: [tool(1, '', '', '{"中文":'), tool(0, '', '', '"a"')] });
  // choice 1/index 0 is NOT the same as choice 0/index 0.
  continued.choices.push({ index: 1, delta: { tool_calls: [tool(0, '', '', 'untouched')] } });
  const finish = chunk({ tool_calls: [tool(1, '', '', '"🙂"}'), tool(0, '', '', ':1')] });
  const output = events(await normalizeSSE(response(bytes(event(first) + event(continued) + event(finish), 3))).text());
  assert.deepEqual(output[0], first);
  for (const frame of output.slice(1)) for (const t of frame.choices[0].delta.tool_calls) {
    assert.equal(Object.hasOwn(t, 'type'), false); assert.equal(Object.hasOwn(t, 'id'), false);
  }
  assert.deepEqual(output[1].choices[1], continued.choices[1]);
  const args = output.flatMap(x => x.choices[0].delta.tool_calls).filter(t => t.index === 1).map(t => t.function.arguments).join('');
  assert.equal(args, '{"中文":"🙂"}');
});

test('comments, controls, multi-line JSON, errors, malformed data and incomplete EOF are preserved', async () => {
  const controls = ': keepalive\r\nid: sse-id\r\nretry: 3000\r\n';
  const header = controls + event(empty).replaceAll('\n', '\r\n');
  const other = 'event: error\ndata: {"error":{"message":"failure"}}\n\ndata: not JSON\n\n: tail';
  const output = await normalizeSSE(response(bytes(header + other))).text();
  assert.equal(output, controls + '\r\n' + other);
  const initial = event(chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function' }] }));
  const multi = 'event: message\nid: retained\ndata: {"object":"chat.completion.chunk",\ndata: "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"arguments":"x"}}]}}]}\n\n';
  const repaired = await normalizeSSE(response(bytes(initial + multi))).text();
  assert.ok(repaired.includes('event: message\nid: retained\ndata: '));
  assert.equal(events(repaired)[1].choices[0].delta.tool_calls[0].function.arguments, 'x');
  assert.equal(events(repaired)[1].choices[0].delta.tool_calls[0].id, undefined);
});

test('a conflicting new tool identity invalidates prior continuation state', async () => {
  const initial = chunk({ tool_calls: [{ index: 0, id: 'first', type: 'function' }] });
  const different = chunk({ tool_calls: [{ index: 0, id: 'second', type: '', function: { arguments: '' } }] });
  const unknown = chunk({ tool_calls: [{ index: 0, id: '', type: '', function: { arguments: 'untrusted continuation' } }] });
  const input = event(initial) + event(different) + event(unknown);
  assert.equal(await normalizeSSE(response(bytes(input))).text(), input);
});

test('JSON responses bypass repair; SSE retains status/headers and drops stale representation headers', async () => {
  const json = Response.json({ error: 'failure' }, { status: 400 });
  assert.equal(normalizeSSE(json), json);
  const sse = new Response('data: [DONE]\n\n', { status: 429, statusText: 'Rate Limited', headers: {
    'content-type': 'text/event-stream; charset=utf-8', 'content-length': '99', 'content-encoding': 'gzip', etag: 'stale', 'x-request-id': 'keep', 'retry-after': '3',
  } });
  const normalized = normalizeSSE(sse);
  assert.equal(normalized.status, 429); assert.equal(normalized.statusText, 'Rate Limited');
  for (const name of ['content-length', 'content-encoding', 'etag']) assert.equal(normalized.headers.get(name), null);
  assert.equal(normalized.headers.get('x-request-id'), 'keep'); assert.equal(normalized.headers.get('retry-after'), '3');
  assert.equal(await normalized.text(), 'data: [DONE]\n\n');
});

test('bounded individual events allow long streams and propagate failures and cancellation', async () => {
  const many = 'data: [DONE]\n\n'.repeat(1000);
  assert.equal(await normalizeSSE(response(bytes(many, 999)), { maxEventChars: 32 }).text(), many);
  await assert.rejects(normalizeSSE(response(bytes('data: ' + 'x'.repeat(100))), { maxEventChars: 32 }).text(), /处理上限/);
  let cancelled, pulls = 0;
  const source = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
    cancel(reason) { cancelled = reason; } });
  const reader = normalizeSSE(response(source)).body.getReader();
  await reader.read();
  await reader.cancel('client stopped');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 'client stopped'); assert.ok(pulls < 5);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('upstream closed')); } });
  await assert.rejects(normalizeSSE(response(broken)).text(), /upstream closed/);
});

test('captured CTYun streams retain every semantic payload, finish reason, usage and DONE', async () => {
  for (const file of ['glm-text', 'deepseek-tool', 'deepseek-length', 'deepseek-error']) {
    const input = await readFile(new URL(`./fixtures/${file}.sse`, import.meta.url), 'utf8');
    const output = await normalizeSSE(response(bytes(input, 17))).text();
    const before = events(input), after = events(output);
    const expected = structuredClone(before);
    if (expected[0]?.id === '') expected.shift();
    // In this captured tool stream all continued tools follow valid initial IDs.
    for (const value of expected) for (const choice of value.choices || []) for (const tool of choice.delta?.tool_calls || []) {
      for (const key of ['id', 'type']) if (tool[key] === '') delete tool[key];
    }
    assert.deepEqual(after, expected, file);
    assert.ok(output.endsWith('data:[DONE]\n\n'), file);
    if (file === 'deepseek-tool') assert.ok(after.some(x => x.usage && x.choices[0].finish_reason === 'tool_calls'));
    if (file === 'deepseek-length') assert.equal(after.at(-1).choices[0].finish_reason, 'length');
    if (file === 'deepseek-error') assert.equal(after.at(-1).error.type, 'upstream_error');
  }
});
