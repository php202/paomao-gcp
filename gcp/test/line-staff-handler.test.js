import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LINE_STAFF_SS_ID = 'staff-ss';
process.env.LINE_HQ_SS_ID = 'hq-ss';
process.env.LINE_STORE_SS_ID = 'store-ss';
process.env.PAO_CAT_CORE_API_URL = 'https://example.com/core';
process.env.PAO_CAT_SECRET_KEY = 'secret';

const { handleStaffCommand, __testables__ } = await import('../scripts/line-staff-handler.js');

test('extractPhoneFromCustomerKeyword normalizes 9-digit mobile', () => {
  assert.equal(__testables__.extractPhoneFromCustomerKeyword('我要了解客人925810424'), '0925810424');
  assert.equal(__testables__.extractPhoneFromCustomerKeyword('我要了解客人 0925-810-424'), '0925810424');
});

test('splitStoreIds splits by commas and deduplicates', () => {
  const ids = __testables__.splitStoreIds(['1001,1002', '1002、1003', ' 1001 ']);
  assert.deepEqual(ids, ['1001', '1002', '1003']);
});

test('handleStaffCommand replies latest activity link', async () => {
  const texts = [];
  const handled = await handleStaffCommand({
    authClient: {},
    text: '最新活動',
    event: { source: { userId: 'U1' } },
    authorizeFn: async () => ({ isAuthorized: true, identity: ['employee'], managedStores: [], workStores: [] }),
    replyText: async (msg) => texts.push(msg),
    replyMessages: async () => {},
    sheetReader: async () => [],
    fetcher: async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }),
  });
  assert.equal(handled, true);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /最新活動資訊/);
});

test('handleStaffCommand returns false for unknown command', async () => {
  const handled = await handleStaffCommand({
    authClient: {},
    text: '未知功能測試',
    event: { source: { userId: 'U1' } },
    authorizeFn: async () => ({ isAuthorized: true, identity: ['employee'], managedStores: [], workStores: [] }),
    replyText: async () => {},
    replyMessages: async () => {},
    sheetReader: async () => [],
    fetcher: async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }),
  });
  assert.equal(handled, false);
});
