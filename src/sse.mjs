const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;

function placeholder(value) {
  if (!record(value) || value.id !== '' || value.object !== 'chat.completion.chunk') return false;
  if (Object.keys(value).some(k => !['id', 'object', 'created', 'model', 'choices'].includes(k))) return false;
  return Array.isArray(value.choices) && value.choices.length > 0 && value.choices.every(choice =>
    record(choice) && Number.isInteger(choice.index) &&
    Object.keys(choice).every(k => ['index', 'delta', 'finish_reason', 'logprobs'].includes(k)) &&
    choice.finish_reason == null && choice.logprobs == null && record(choice.delta) &&
    choice.delta.role === 'assistant' &&
    Object.keys(choice.delta).every(k => ['role', 'content'].includes(k)) &&
    (choice.delta.content === undefined || choice.delta.content === ''));
}

// Only this response's state is retained. Tool indices are scoped per choice;
// an unknown/malformed initial tool delta must never acquire invented IDs.
function frameNormalizer() {
  let initial = true;
  const tools = new Map();
  return lines => {
    const data = lines.filter(({ line }) => line === 'data' || line.startsWith('data:'));
    if (!data.length) return lines.map(x => x.line + x.eol).join('');
    const payload = data.map(({ line }) => line.slice(5).replace(/^ /, '')).join('\n');
    let value;
    try { value = JSON.parse(payload); } catch { initial = false; return lines.map(x => x.line + x.eol).join(''); }
    // Non-message events (e.g. errors) are never removed or rewritten.
    const events = lines.filter(x => x.line.startsWith('event:')).map(x => x.line.slice(6).trim());
    if (events.some(x => x && x !== 'message')) { initial = false; return lines.map(x => x.line + x.eol).join(''); }
    if (initial && placeholder(value)) {
      // Retain comments and SSE control fields even when dropping data.
      return lines.filter(x => !data.includes(x)).map(x => x.line + x.eol).join('');
    }
    initial = false;
    let changed = false;
    if (record(value) && value.object === 'chat.completion.chunk' && !Object.hasOwn(value, 'error') && Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        if (!record(choice) || !Number.isInteger(choice.index) || !Array.isArray(choice.delta?.tool_calls)) continue;
        for (const tool of choice.delta.tool_calls) {
          if (!record(tool) || !Number.isInteger(tool.index)) continue;
          const key = `${choice.index}:${tool.index}`;
          const known = tools.get(key);
          if (tool.type === 'function' && nonempty(tool.id)) tools.set(key, tool.id);
          else if ((nonempty(tool.id) && tool.id !== known) || (nonempty(tool.type) && tool.type !== 'function')) tools.delete(key);
          else if (known && (!nonempty(tool.id) || tool.id === known) && (!nonempty(tool.type) || tool.type === 'function')) {
            for (const field of ['id', 'type']) if (tool[field] === '') { delete tool[field]; changed = true; }
          }
        }
      }
    }
    if (!changed) return lines.map(x => x.line + x.eol).join('');
    let written = false;
    return lines.map(entry => {
      if (!data.includes(entry)) return entry.line + entry.eol;
      if (written) return '';
      written = true;
      return `data: ${JSON.stringify(value)}${entry.eol}`;
    }).join('');
  };
}

// Incremental SSE parsing: accept LF, CRLF and CR even when a UTF-8 code point
// or CRLF pair crosses network chunks. The cap applies to one event, not the
// whole stream; cancellation/errors propagate through pipeThrough.
export function normalizeSSE(response, { maxEventChars = 1024 * 1024 } = {}) {
  if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || '')) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const normalize = frameNormalizer();
  let lines = [], parts = [], count = 0, pendingCR = false;
  const add = text => {
    count += text.length;
    if (count > maxEventChars) throw new Error('天翼云 SSE 单个事件超过插件处理上限');
    parts.push(text);
  };
  const emit = controller => {
    const output = normalize(lines);
    if (output) controller.enqueue(encoder.encode(output));
    lines = []; count = 0;
  };
  const endLine = (eol, controller) => {
    add(eol);
    const text = parts.join('');
    const line = text.slice(0, -eol.length);
    parts = [];
    lines.push({ line, eol });
    if (line === '') emit(controller);
  };
  const consume = (text, controller) => {
    let start = 0;
    if (pendingCR) {
      if (!text.length) return;
      pendingCR = false;
      endLine(text[0] === '\n' ? '\r\n' : '\r', controller);
      if (text[0] === '\n') start = 1;
    }
    for (let i = start; i < text.length; i++) {
      if (text[i] !== '\r' && text[i] !== '\n') continue;
      add(text.slice(start, i));
      if (text[i] === '\r' && i + 1 === text.length) { pendingCR = true; return; }
      const eol = text[i] === '\r' && text[i + 1] === '\n' ? '\r\n' : text[i];
      endLine(eol, controller);
      i += eol.length - 1; start = i + 1;
    }
    if (start < text.length) add(text.slice(start));
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true }), controller); },
    flush(controller) {
      consume(decoder.decode(), controller);
      if (pendingCR) endLine('\r', controller);
      if (parts.length) { lines.push({ line: parts.join(''), eol: '' }); parts = []; }
      if (lines.length) emit(controller);
    },
  }));
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']) headers.delete(name);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
