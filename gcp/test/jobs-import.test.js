import test from 'node:test';
import assert from 'node:assert/strict';

test('job scripts export run()', async () => {
  const a = await import('../scripts/check-timeout-pending.js');
  const b = await import('../scripts/cleanup-retention-list.js');
  const c = await import('../scripts/waitlist-auto-push.js');
  assert.equal(typeof a.run, 'function');
  assert.equal(typeof b.run, 'function');
  assert.equal(typeof c.run, 'function');
});

