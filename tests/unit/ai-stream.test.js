import test from 'node:test';
import assert from 'node:assert/strict';

const { createSseParser, parseStreamData, usageTotals } =
  await import('../../src/scripts/features/ai/stream.js');

function collect() {
  const events = [];
  return { events, parser: createSseParser((payload) => events.push(payload)) };
}

test('SSE parser: frames split across chunks are reassembled', () => {
  const { events, parser } = collect();
  parser.push('data: {"del');
  parser.push('ta":"Hel"}\n\ndata: {"delta":"lo"}\n');
  parser.push('\ndata: [DONE]\n\n');
  assert.deepEqual(events, ['{"delta":"Hel"}', '{"delta":"lo"}', '[DONE]']);
});

test('SSE parser: CRLF line endings and CRLF split across chunks', () => {
  const { events, parser } = collect();
  parser.push('data: {"delta":"a"}\r');
  parser.push('\n\r\ndata: [DONE]\r\n\r\n');
  assert.deepEqual(events, ['{"delta":"a"}', '[DONE]']);
});

test('SSE parser: ignores non-data lines and empty payloads', () => {
  const { events, parser } = collect();
  parser.push('event: message\nretry: 1000\ndata: \ndata: {"delta":"x"}\n\n');
  assert.deepEqual(events, ['{"delta":"x"}']);
});

test('SSE parser: flush emits a trailing frame without a blank line', () => {
  const { events, parser } = collect();
  parser.push('data: {"delta":"tail"}\n');
  assert.equal(events.length, 0, 'incomplete frame waits for more data');
  parser.flush();
  assert.deepEqual(events, ['{"delta":"tail"}']);
});

test('parseStreamData: BYOK/OpenAI chunk shapes', () => {
  assert.deepEqual(parseStreamData('{"choices":[{"delta":{"content":"Hi"}}]}'), { delta: 'Hi' });
  assert.deepEqual(parseStreamData('{"choices":[{"delta":{},"role":"assistant"}]}'), null,
    'role-only first chunk yields no event');
  assert.deepEqual(
    parseStreamData('{"model":"llama-x","usage":{"prompt_tokens":10,"completion_tokens":4}}'),
    { usage: { prompt_tokens: 10, completion_tokens: 4 }, model: 'llama-x' },
  );
  assert.deepEqual(
    parseStreamData('{"x_groq":{"usage":{"prompt_tokens":7,"completion_tokens":3}}}'),
    { usage: { prompt_tokens: 7, completion_tokens: 3 } },
  );
});

test('parseStreamData: proxy normalized chunk shapes', () => {
  assert.deepEqual(parseStreamData('{"delta":"streamed"}'), { delta: 'streamed' });
  assert.deepEqual(parseStreamData('[DONE]'), { done: true });
  assert.deepEqual(
    parseStreamData('{"error":{"code":"timeout","message":"stalled","retryable":true}}'),
    { error: { code: 'timeout', message: 'stalled', retryable: true } },
  );
  assert.deepEqual(
    parseStreamData('{"error":{"message":"boom"}}'),
    { error: { code: 'upstream_error', message: 'boom', retryable: false } },
  );
});

test('parseStreamData: malformed payloads are tolerated, not thrown', () => {
  assert.equal(parseStreamData('not json at all'), null);
  assert.equal(parseStreamData(''), null);
  assert.equal(parseStreamData('42'), null);
});

test('usageTotals: normalizes raw and pre-normalized usage', () => {
  assert.deepEqual(usageTotals({ prompt_tokens: 120, completion_tokens: 45 }), { prompt: 120, completion: 45 });
  assert.deepEqual(usageTotals({ prompt: 9, completion: null }), { prompt: 9, completion: null });
  assert.equal(usageTotals(null), null);
  assert.equal(usageTotals({}), null, 'no usable numbers → null (nothing is fabricated)');
  assert.equal(usageTotals('junk'), null);
});

test('streaming contract: a full Groq-style reply round-trips through the parser', () => {
  const { events, parser } = collect();
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Flo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"w:"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":33,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ];
  // Feed in awkward chunk sizes to prove the incremental path.
  const wire = frames.join('');
  for (let i = 0; i < wire.length; i += 7) parser.push(wire.slice(i, i + 7));
  parser.flush();

  const parsed = events.map(parseStreamData).filter(Boolean);
  const text = parsed.filter((e) => e.delta !== undefined).map((e) => e.delta).join('');
  const usage = parsed.find((e) => e.usage)?.usage ?? null;
  assert.equal(text, 'Flow:');
  assert.equal(usage.completion_tokens, 2);
  assert.ok(parsed.some((e) => e.done), '[DONE] must survive the pipeline');
});
