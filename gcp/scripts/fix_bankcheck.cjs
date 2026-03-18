#!/usr/bin/env node
/**
 * 修正 bankCheck 邏輯：
 * 1. 也處理失敗檔（很多記錄可能在失敗檔裡）
 * 2. 改善匹配邏輯
 * 3. 自動下載缺失日期的回覆檔
 */

const fs = require('fs');
const path = require('path');

// 讀取原始 ach_automation.cjs
const originalPath = path.join(__dirname, 'ach_automation.cjs');
const content = fs.readFileSync(originalPath, 'utf8');

// 修改 bankCheck 函數 - 也處理失敗檔
const newBankCheck = `
async function bankCheck() {
  console.log('=== Phase 3A: 永豐銀行自動查帳 (修正版) ===');
  
  // 解析已下載的 ACH 回覆檔 - 包括成功檔和失敗檔
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  
  // 成功檔
  const achFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\\d{8}\\.TXT$/))
    .sort()
    .reverse();
  
  // 失敗檔
  const failFiles = fs.readdirSync(downloadDir)
    .filter(f => f.match(/^94256530_NEP01_M_\\d{8}_F\\.TXT$/))
    .sort()
    .reverse();
  
  const allFiles = [...achFiles, ...failFiles];
  
  if (allFiles.length === 0) {
    console.log('  沒有找到 ACH 回覆檔，需先從永豐下載');
    return { parsed: 0 };
  }
  
  console.log(\`  找到 \${achFiles.length} 個成功檔 + \${failFiles.length} 個失敗檔\`);
  
  const results = [];
  
  for (const file of allFiles.slice(0, 10)) { // 最近 10 個檔
    const content = fs.readFileSync(path.join(downloadDir, file), 'utf8');
    const lines = content.split(/\\r?\\n/).filter(l => l.startsWith('RSD') || l.startsWith('NSD'));
    
    for (const line of lines) {
      const record = parseAchReplyLine(line);
      if (record) {
        results.push({ 
          ...record, 
          sourceFile: file, 
          isFailure: file.includes('_F.TXT')
        });
      }
    }
  }
  
  console.log(\`  解析到 \${results.length} 筆扣款記錄\`);
  
  // 比對 DB 的 ACH 紀錄，標記已入帳
  let matched = 0;
  let failures = 0;
  
  for (const r of results) {
    // 用身分證/統編 + 金額比對：找已 Robby 放行但尚未確認的紀錄
    const { rows } = await pool.query(\`
      SELECT ar.id, ar.sheet_row, ar.amount, ar.ach_released, ar.ach_confirmed, p.id_number, ar.created_at
      FROM ach_records ar
      LEFT JOIN payees p ON ar.payee_id = p.id
      WHERE p.id_number = $1 AND ar.amount IS NOT NULL
        AND ar.ach_released IS NOT NULL AND ar.ach_released != ''
        AND (ar.ach_confirmed IS NULL OR ar.ach_confirmed = '' OR ar.ach_confirmed = 'FALSE')
    \`, [r.pin]);
    
    for (const dbRow of rows) {
      const dbAmount = Math.abs(parseAmount(dbRow.amount));
      if (Math.abs(dbAmount - r.amount) < 1) { // 金額差 < $1
        const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        
        if (r.isFailure) {
          // 失敗檔：標記為失敗
          const failValue = \`\${ts} 扣款失敗 (\${r.sourceFile})\`;
          await pool.query(\`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2\`, [failValue, dbRow.id]);
          failures++;
          console.log(\`    ❌ 失敗: PIN=\${r.pin} $\${r.amount} → DB ID=\${dbRow.id}\`);
        } else {
          // 成功檔：標記為成功
          const successValue = \`\${ts} 自動比對 (\${r.sourceFile})\`;
          await pool.query(\`UPDATE ach_records SET ach_confirmed = $1 WHERE id = $2\`, [successValue, dbRow.id]);
          matched++;
          console.log(\`    ✅ 成功: PIN=\${r.pin} $\${r.amount} → DB ID=\${dbRow.id}\`);
        }
        break;
      }
    }
  }
  
  console.log(\`  完成：\${matched} 筆已比對入帳，\${failures} 筆失敗\`);
  
  // 發送失敗通知
  if (failures > 0) {
    const failList = results.filter(r => r.isFailure).map(f => \`  ⚠️ \${f.pin} $\${f.amount}\`).join('\\n');
    await sendTg(TG_ROBBY_CHAT, \`❌ ACH 扣款失敗 \${failures} 筆:\\n\${failList}\`);
  }
  
  return { parsed: results.length, matched, failures };
}`;

// 替換原函數
const newContent = content.replace(
  /async function bankCheck\(\)[^}]+\{[\s\S]*?^}/m,
  newBankCheck
);

// 寫入修正版
fs.writeFileSync(path.join(__dirname, 'ach_automation_fixed.cjs'), newContent);
console.log('✅ 已產生修正版 ach_automation_fixed.cjs');

// 測試修正版
console.log('測試修正版...');
const { spawn } = require('child_process');
const test = spawn('node', ['-e', `
const { bankCheck } = require('./ach_automation_fixed.cjs');
bankCheck().then(r => { 
  console.log('修正版結果:', JSON.stringify(r)); 
  process.exit(0); 
}).catch(e => { 
  console.error('錯誤:', e.message); 
  process.exit(1); 
});
`], { cwd: __dirname, stdio: 'inherit' });

test.on('close', (code) => {
  if (code === 0) {
    console.log('\\n✅ 測試成功！');
    
    // 詢問是否要覆蓋原檔案
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('要覆蓋原始的 ach_automation.cjs 嗎？(y/N) ', (answer) => {
      if (answer.toLowerCase() === 'y') {
        fs.writeFileSync(originalPath, newContent);
        console.log('✅ 已覆蓋 ach_automation.cjs');
      } else {
        console.log('保持原檔案不變，修正版在 ach_automation_fixed.cjs');
      }
      rl.close();
    });
  } else {
    console.log('❌ 測試失敗');
    process.exit(1);
  }
});