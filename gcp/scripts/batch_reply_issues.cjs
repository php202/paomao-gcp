#!/usr/bin/env node
/**
 * 批次回覆待回覆問題
 * 每 30 分鐘執行一次
 * 
 * 1. 查 status='pending_reply' 且 replied_at IS NULL 的問題
 * 2. 依 line_group_id 分組
 * 3. 每個群組合併成一則訊息 push 出去
 * 4. 更新 replied_at + status='resolved'
 */

const { Pool } = require('pg');
const pool = new Pool({ database: 'paomao' });

const TG_BOT_TOKEN = '8520607475:AAHKn1oBOmTGloSzvM_Y0ps41tigRG3torc';
const TG_ROBBY_CHAT = '7956245081';

// LINE Bot token (泡泡貓 LINE@ — same as paopao-webhook.js)
const LINE_CHANNEL_TOKEN = 'cpJinkc6qjthP9/685wxeI114mz/TPYieKdtabf0KIkuzpf1mGLFIRKSbVoCD7QAtIf7pBSJrI8I3x7Pk2Z5khTFbCgsaos749+4MjrIFoW5+90ppxSguaWlvYGGoLHGgMHzmJejEHWIlggnfMBqKQdB04t89/1O/w1cDnyilFU=';

async function sendTg(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_ROBBY_CHAT, text, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('[TG]', e.message); }
}

async function pushLineMessage(groupId, text) {
  if (!LINE_CHANNEL_TOKEN || !groupId) return false;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_TOKEN}`
      },
      body: JSON.stringify({
        to: groupId,
        messages: [{ type: 'text', text }]
      })
    });
    return res.ok;
  } catch(e) {
    console.error('[LINE push]', e.message);
    return false;
  }
}

async function main() {
  console.log('[batch-reply] 檢查待回覆問題...');

  const { rows } = await pool.query(`
    SELECT issue_number, store_name, description, reply_message, line_group_id, assignee
    FROM issues
    WHERE status = 'pending_reply' AND replied_at IS NULL
    ORDER BY line_group_id, issue_number
  `);

  if (!rows.length) {
    console.log('[batch-reply] 沒有待回覆問題');
    await pool.end();
    return;
  }

  console.log(`[batch-reply] 找到 ${rows.length} 筆待回覆`);

  // Group by line_group_id
  const groups = {};
  for (const r of rows) {
    const gid = r.line_group_id || 'no_group';
    if (!groups[gid]) groups[gid] = [];
    groups[gid].push(r);
  }

  let pushed = 0, failed = 0;

  for (const [groupId, issues] of Object.entries(groups)) {
    // Build combined message
    const lines = ['📋 問題回覆通知\n'];
    for (const issue of issues) {
      const store = (issue.store_name || '').replace('泡泡貓｜', '');
      lines.push(`🔹 ${store ? store + '：' : ''}${issue.description.slice(0, 60)}`);
      lines.push(`   ➜ ${issue.reply_message}`);
      lines.push('');
    }
    const message = lines.join('\n').trim();

    let success = false;
    if (groupId !== 'no_group') {
      success = await pushLineMessage(groupId, message);
      if (success) pushed++;
      else failed++;
    } else {
      // No LINE group — just mark as done
      success = true;
    }

    // Update all issues in this group
    const nums = issues.map(i => i.issue_number);
    const now = new Date().toISOString();
    for (const num of nums) {
      await pool.query(
        "UPDATE issues SET status='resolved', replied_at=$1, resolved_at=NOW(), updated_at=NOW() WHERE issue_number=$2",
        [now, num]
      );
    }

    console.log(`[batch-reply] Group ${groupId.slice(0, 20)}...: ${issues.length} issues, push=${success}`);
  }

  const summary = `💬 批次回覆完成：${rows.length} 筆問題，${pushed} 群組已推送`;
  console.log(`[batch-reply] ${summary}`);
  if (pushed > 0 || failed > 0) await sendTg(summary);

  await pool.end();
}

main().catch(e => { console.error('[batch-reply] FATAL:', e); process.exit(1); });
