#!/usr/bin/env node
/**
 * ACH 對帳 Cron 作業
 * 每天 10:00/15:00 執行：
 * 1. 檢查有 pending ACH 的日期
 * 2. 嘗試下載缺失的銀行回覆檔
 * 3. 執行 bankCheck 比對
 * 4. 發送結果通知
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { bankCheck } = require('./ach_automation.cjs');

const pool = new Pool({ host: '/tmp', database: 'paomao', user: 'paopaomao' });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = '7956245081'; // Robby

async function sendTg(text) {
  if (!TG_BOT_TOKEN) { 
    console.log(`[TG] ${text}`);
    return; 
  }
  
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: TG_CHAT_ID, 
        text, 
        parse_mode: 'HTML' 
      }),
    });
  } catch (e) {
    console.error('[TG error]', e.message);
  }
}

async function getPendingDates() {
  const { rows } = await pool.query(`
    SELECT TO_CHAR(created_at, 'YYYYMMDD') AS date_str, 
           DATE(created_at) AS date_obj,
           COUNT(*) AS count,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS positive_sum,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS negative_sum
    FROM ach_records 
    WHERE is_active = true 
      AND ach_released IS NOT NULL AND ach_released != ''
      AND (ach_confirmed IS NULL OR ach_confirmed = '' OR ach_confirmed = 'FALSE')
    GROUP BY DATE(created_at), TO_CHAR(created_at, 'YYYYMMDD')
    ORDER BY date_obj DESC
  `);
  
  return rows;
}

async function checkExistingFiles(dateStr) {
  const downloadDir = path.join(process.env.HOME, 'Downloads');
  
  // 檢查是否已有該日期的回覆檔
  const successFile = `94256530_NEP01_M_${dateStr}.TXT`;
  const failureFile = `94256530_NEP01_M_${dateStr}_F.TXT`;
  
  const hasSuccess = fs.existsSync(path.join(downloadDir, successFile));
  const hasFailure = fs.existsSync(path.join(downloadDir, failureFile));
  
  return { hasSuccess, hasFailure, hasAny: hasSuccess || hasFailure };
}

async function attemptDownload(dateStr) {
  console.log(`[download] 嘗試下載 ${dateStr} 的回覆檔...`);
  
  try {
    // 使用完整的下載腳本
    const { spawn } = require('child_process');
    
    const downloadProcess = spawn('node', [
      path.join(__dirname, 'sinopac_download_complete.cjs'),
      dateStr
    ], {
      cwd: __dirname,
      stdio: 'pipe',
      timeout: 300000 // 5 分鐘逾時
    });
    
    let stdout = '';
    let stderr = '';
    
    downloadProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    downloadProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    return new Promise((resolve) => {
      downloadProcess.on('close', (code) => {
        const success = code === 0 && !stderr.includes('錯誤') && !stderr.includes('失敗');
        console.log(`[download] ${dateStr} 結果: code=${code}, success=${success}`);
        if (stdout) console.log(`[download] stdout: ${stdout.substring(0, 500)}`);
        if (stderr) console.log(`[download] stderr: ${stderr.substring(0, 500)}`);
        
        resolve({ success, code, stdout, stderr });
      });
      
      downloadProcess.on('error', (err) => {
        console.log(`[download] ${dateStr} 錯誤: ${err.message}`);
        resolve({ success: false, error: err.message });
      });
    });
  } catch (e) {
    console.log(`[download] ${dateStr} 例外: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function main() {
  console.log(`[ACH Reconcile Cron] 開始執行 - ${new Date().toISOString()}`);
  
  try {
    // 1. 檢查 pending 日期
    const pendingDates = await getPendingDates();
    
    if (pendingDates.length === 0) {
      console.log('[main] 沒有 pending 的 ACH 記錄');
      await sendTg('ℹ️ ACH 對帳：沒有需要處理的記錄');
      return;
    }
    
    console.log(`[main] 找到 ${pendingDates.length} 個 pending 日期:`);
    pendingDates.forEach(d => {
      console.log(`  ${d.date_str}: ${d.count} 筆, +$${d.positive_sum || 0}, $${d.negative_sum || 0}`);
    });
    
    // 2. 檢查現有檔案
    const missingDates = [];
    const availableDates = [];
    
    for (const dateInfo of pendingDates) {
      const fileStatus = await checkExistingFiles(dateInfo.date_str);
      
      if (fileStatus.hasAny) {
        availableDates.push(dateInfo);
        console.log(`[main] ${dateInfo.date_str}: 已有回覆檔`);
      } else {
        missingDates.push(dateInfo);
        console.log(`[main] ${dateInfo.date_str}: 缺少回覆檔`);
      }
    }
    
    // 3. 嘗試下載缺失的檔案（僅最近 7 天）
    const recentMissingDates = missingDates.filter(d => {
      const diffDays = (new Date() - d.date_obj) / (1000 * 60 * 60 * 24);
      return diffDays <= 7;
    });
    
    if (recentMissingDates.length > 0) {
      console.log(`[main] 嘗試下載 ${recentMissingDates.length} 個近期缺失日期...`);
      
      for (const dateInfo of recentMissingDates) {
        const downloadResult = await attemptDownload(dateInfo.date_str);
        
        if (downloadResult.success) {
          console.log(`[main] ✅ ${dateInfo.date_str} 下載成功`);
          availableDates.push(dateInfo);
        } else {
          console.log(`[main] ❌ ${dateInfo.date_str} 下載失敗: ${downloadResult.error || '未知錯誤'}`);
        }
        
        // 避免過於頻繁的請求
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    
    // 4. 執行 bankCheck 比對現有檔案
    console.log('[main] 執行 bankCheck 比對...');
    const bankCheckResult = await bankCheck();
    
    // 5. 發送結果通知
    const summary = [
      `📊 ACH 對帳結果 (${new Date().toLocaleString('zh-TW')})`,
      ``,
      `📋 Pending 日期: ${pendingDates.length} 個`,
      `📁 有回覆檔: ${availableDates.length} 個`,
      `❓ 缺少回覆檔: ${missingDates.length} 個`,
      ``,
      `🔍 比對結果:`,
      `  解析: ${bankCheckResult.parsed} 筆`,
      `  ✅ 成功: ${bankCheckResult.matched} 筆`,
      `  ❌ 失敗: ${bankCheckResult.failures} 筆`
    ];
    
    if (missingDates.length > 0) {
      const oldMissing = missingDates.filter(d => {
        const diffDays = (new Date() - d.date_obj) / (1000 * 60 * 60 * 24);
        return diffDays > 7;
      });
      
      if (oldMissing.length > 0) {
        summary.push(``, `⚠️ 較舊的缺失日期需手動處理:`);
        oldMissing.forEach(d => {
          summary.push(`  ${d.date_str} (${d.count} 筆)`);
        });
      }
    }
    
    const notification = summary.join('\n');
    console.log('\n' + notification);
    
    // 只有在有實際結果或問題時才發送通知
    if (bankCheckResult.matched > 0 || bankCheckResult.failures > 0 || missingDates.length > 0) {
      await sendTg(notification);
    }
    
  } catch (e) {
    console.error('[main] 錯誤:', e.message);
    await sendTg(`❌ ACH 對帳 Cron 錯誤: ${e.message}`);
  } finally {
    await pool.end();
  }
  
  console.log(`[ACH Reconcile Cron] 完成 - ${new Date().toISOString()}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}