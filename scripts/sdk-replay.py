#!/usr/bin/env python3
"""Replay captured SSE through the real plugin and OpenAI SDK, offline only.

Dev dependencies: openai==2.48.0 httpx==0.28.1 (not plugin dependencies).
httpx.MockTransport handles every SDK call. Node's fetch is also stubbed.
"""
import json
from pathlib import Path
import subprocess

import httpx
import openai

ROOT = Path(__file__).resolve().parents[1]


def replay(raw):
    def response(request):
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=raw, request=request)

    with httpx.Client(transport=httpx.MockTransport(response)) as transport:
        client = openai.OpenAI(api_key='offline-placeholder', base_url='https://offline.invalid/v1',
                               http_client=transport, max_retries=0)
        try:
            with client.chat.completions.stream(model='offline-fixture', messages=[]) as stream:
                list(stream)
                return stream.get_final_completion(), None
        except Exception as error:
            return None, type(error).__name__


rows = []
for name in ['glm-text', 'deepseek-tool', 'deepseek-length', 'deepseek-error']:
    path = ROOT / 'test' / 'fixtures' / f'{name}.sse'
    raw = path.read_bytes()
    repaired = subprocess.run(['node', str(ROOT / 'scripts' / 'normalize-fixture.mjs'), str(path)],
                              check=True, capture_output=True).stdout
    original, original_error = replay(raw)
    completion, error = replay(repaired)
    if name in ['glm-text', 'deepseek-tool']:
        assert error is None, (name, error)
        assert completion.id, name
        assert completion.usage.total_tokens > 0
        if name == 'glm-text':
            assert original_error is None and original.id == ''
            assert completion.choices[0].message.content == original.choices[0].message.content
            assert completion.choices[0].message.reasoning_content == original.choices[0].message.reasoning_content
        else:
            assert original_error == 'AssertionError', original_error
            tool = completion.choices[0].message.tool_calls[0]
            assert tool.id == 'call_fixture_0_0'
            assert tool.type == 'function' and tool.function.name == 'lookup_test_code'
            assert json.loads(tool.function.arguments) == {'key': 'probe-73'}
            assert completion.choices[0].finish_reason == 'tool_calls'
    else:
        expected = 'LengthFinishReasonError' if name == 'deepseek-length' else 'APIError'
        assert error == original_error == expected, (name, original_error, error)
    rows.append({'fixture': name, 'raw': original_error or ('empty_id' if not original.id else 'ok'),
                 'plugin': error or 'ok'})

print(json.dumps({'openai_sdk': openai.__version__, 'network_calls': 0, 'checks': rows}, ensure_ascii=False))
