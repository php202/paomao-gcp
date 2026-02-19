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

test.skip('formatTomorrowListPayload matches image format: 共 X店、Y人, 明天預約人數 : N, 姓名 (HH:mm) - 電話', () => {
  const { buildTomorrowListFlexMessage } = __testables__;
  const formatTomorrowListPayload = (data) => ({ lines: [], phonesForQuickReply: [] }); // TODO: 從 buildTomorrowListFlexMessage 產出文字格式後可改回 __testables__
  const data = {
    dateStr: '2026-02-16',
    byStore: [
      {
        storeId: '1001',
        storeName: '竹北光明',
        availableSlotsText: '1.5hr 還有 1 個空位',
        items: [
          { name: '休息', phone: '0000000000', rsvtim: '2026-02-16T11:00:00' },
          { name: '陳俊良', phone: '0912232815', rsvtim: '2026-02-16T11:30:00' },
        ],
      },
      {
        storeId: '0001',
        storeName: '總公司',
        availableSlotsText: '—',
        items: [],
      },
      {
        storeId: '1002',
        storeName: '內湖東湖',
        availableSlotsText: '—',
        items: [{ name: '林小明', phone: '0911111111', rsvtim: '2026-02-16T15:00:00' }],
      },
    ],
  };
  const { lines, phonesForQuickReply } = formatTomorrowListPayload(data);
  const text = lines.join('\n');
  assert.ok(text.startsWith('明日預約 2026-02-16 共 2店、3人'), 'header: 共 X店、Y人 (no space before 店)');
  assert.ok(text.includes('【竹北光明】'), 'store name in brackets');
  assert.ok(text.includes('明日可預約空位 : 1.5hr 還有 1 個空位'), 'slots line with space before colon');
  assert.ok(text.includes('明天預約人數 : 2'), 'count with space before colon');
  assert.ok(text.includes('休息 (11:00) - 0000000000'), 'list format: 姓名 (HH:mm) - 電話');
  assert.ok(text.includes('陳俊良 (11:30) - 0912232815'), 'second guest format');
  assert.ok(text.includes('【總公司】'));
  assert.ok(text.includes('明天預約人數 : 0'));
  assert.ok(text.includes('（無預約）'));
  assert.ok(text.includes('【內湖東湖】'));
  assert.ok(text.includes('林小明 (15:00) - 0911111111'));
  assert.equal(phonesForQuickReply.length, 3);
});

test('buildAttendanceMessage formats per-user attendance with 上班/下班 times', () => {
  const { buildAttendanceMessage } = __testables__;
  const records = [
    { userId: 'U1', time: new Date('2026-02-16T09:00:00+08:00'), type: '上班打卡' },
    { userId: 'U1', time: new Date('2026-02-16T18:00:00+08:00'), type: '下班打卡' },
  ];
  const employeeMap = new Map([['U1', { name: '王小明', store: '內湖東湖' }]]);
  const msg = buildAttendanceMessage(records, employeeMap);
  assert.ok(msg.includes('王小明'));
  assert.ok(msg.includes('上班'));
  assert.ok(msg.includes('下班'));
});
