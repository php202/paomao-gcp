import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAO_CAT_SECRET_KEY = 'k';

const { __testables__ } = await import('../api/core-api.js');

test('normalizePhone9', () => {
  assert.equal(__testables__.normalizePhone9('925810424'), '0925810424');
  assert.equal(__testables__.normalizePhone9('0925-810-424'), '0925810424');
});

test('md5Upper matches known', () => {
  assert.equal(__testables__.md5Upper('a'), '0CC175B9C0F1B6A831C399E269772661');
});

