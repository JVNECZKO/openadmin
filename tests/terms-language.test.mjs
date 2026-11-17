import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMS, term } from '../src/ui/terms.mjs';

test('Polish product vocabulary is complete and contains no accidental English labels', () => {
  for (const [group, entries] of Object.entries(TERMS)) {
    for (const [key, pair] of Object.entries(entries)) {
      assert.equal(pair.length, 2, `${group}.${key}`);
      assert.ok(pair[1], `${group}.${key} has Polish term`);
      if (key !== 'ok') assert.notEqual(pair[1], pair[0], `${group}.${key} must be translated`);
    }
  }
  assert.equal(term('pl', 'actions', 'delete'), 'Usuń');
  assert.equal(term('en', 'actions', 'delete'), 'Delete');
  assert.equal(term('pl', 'status', 'suspended'), 'Zawieszona');
});
