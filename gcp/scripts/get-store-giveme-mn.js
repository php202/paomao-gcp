/**
 * 從試算表「店家基本資料」讀取指定 storid 的 M 欄（Giveme 帳號/密碼）、N 欄（統一編號）。
 * 執行：cd gcp && source set-env.sh 2>/dev/null; node scripts/get-store-giveme-mn.js [storid]
 * 預設 storid=0001。輸出可填入 set-env.sh：N→GIVEME_UNCODE，M→GIVEME_IDNO,GIVEME_PASSWORD
 */
import { getAuth } from '../lib/auth.js';
import { readSheet } from '../lib/sheets.js';

const LINE_STORE_SS_ID = (process.env.LINE_STORE_SS_ID || '').trim();
const storid = (process.argv[2] || '0001').trim();

async function main() {
  if (!LINE_STORE_SS_ID) {
    console.error('請設定 LINE_STORE_SS_ID（例：source set-env.sh）');
    process.exit(1);
  }
  const auth = await getAuth();
  const rows = await readSheet(auth, LINE_STORE_SS_ID, "'店家基本資料'!A:N");
  const needle = storid;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const fVal = String(row[5] ?? '').trim();
    if (fVal !== needle) continue;
    const mVal = String(row[12] ?? '').trim();
    const nVal = String(row[13] ?? '').trim();
    console.log('storid=%s 找到列 %s', needle, i + 1);
    console.log('  N 欄（統一編號 uncode）=%s', nVal || '(空)');
    console.log('  M 欄（帳號/密碼）=%s', mVal ? mVal.replace(/password["\s:]+[^,"}\s]+/gi, 'password:***') : '(空)');
    if (nVal) console.log('  → GIVEME_UNCODE=%s', nVal);
    if (mVal) {
      let idno = '', password = '';
      try {
        const parsed = JSON.parse(mVal);
        if (parsed?.idno) idno = parsed.idno.trim();
        if (parsed?.password) password = parsed.password.trim();
      } catch {
        const parts = mVal.split(/[,|]/).map((s) => s.trim());
        if (parts.length >= 2) {
          idno = parts[0];
          password = parts[1];
        }
      }
      if (idno) console.log('  → GIVEME_IDNO=%s', idno);
      if (password) console.log('  → GIVEME_PASSWORD=***');
    }
    return;
  }
  console.error('storid=%s 在試算表「店家基本資料」找不到（F 欄）', needle);
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
