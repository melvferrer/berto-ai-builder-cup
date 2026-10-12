// Public-edition tests: the proprietary safety rule set is not in this repo, so these only check the
// stub interface and the multilingual plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emergencyCheck, isDoseQuestion, filterSentence, takeSentences, disclaimerFor } from '../shared/safety.js';
import { LANG_CODES, detectLang, normLang } from '../shared/lang.js';

test('placeholder emergency keyword -> call local emergency services', () => {
  const r = emergencyCheck('I think this is an emergency, chest pain');
  assert.equal(r.level, 'symptom');
  assert.match(r.reply, /emergency services/);
  assert.equal(emergencyCheck('good morning Berto'), null);
});
test('placeholder dose block', () => {
  assert.equal(isDoseQuestion('what dose should I take?'), true);
  assert.equal(isDoseQuestion('what should I eat for breakfast?'), false);
});
test('filterSentence strips markdown', () => { assert.equal(filterSentence('**Walk** daily.').text, 'Walk daily.'); });
test('takeSentences splits streamed text', () => {
  const [s, rest] = takeSentences('Hello there. 6.5% is fine! And mo');
  assert.deepEqual(s, ['Hello there.', '6.5% is fine!']); assert.equal(rest, ' And mo');
});
test('disclaimer exists for every language', () => { for (const l of LANG_CODES) assert.ok(disclaimerFor(l)); });
test('11 locales registered and script detection works', () => {
  assert.ok(LANG_CODES.length >= 11);
  assert.equal(normLang('xx'), 'fil');
  assert.equal(detectLang('こんにちは'), 'ja');
  assert.equal(detectLang('안녕하세요'), 'ko');
});
