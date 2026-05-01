/**
 * 員工自主補打卡 API + 出勤查詢
 * 
 * Endpoints (via query param `action`):
 *   GET  ?action=my-attendance&line_user_id=xxx[&days=7]      — 員工查詢近N天出勤記錄
 *   POST ?action=makeup-punch  { line_user_id, date, time, reason, edit_type, check_type }  — 提交補打卡
 *   GET  ?action=manager-attendance&store_name=xxx&date=YYYY-MM-DD  — 店長查門市出勤
 *   POST ?action=manager-edit  { checkin_record_id, new_time, reason, editor_line_user_id } — 店長編輯
 *   GET  ?action=makeup-log&store_name=xxx[&month=YYYY-MM]    — 補打卡審計紀錄
 *   GET  ?action=edit-details&checkin_record_id=xxx            — 查詢某筆打卡的編輯記錄
 */

import pool from '../lib/db.js';

/** 台北時間 YYYY-MM-DD */
function todayTpe() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/** 日期差（天） */
function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00+08:00');
  const d2 = new Date(dateStr2 + 'T00:00:00+08:00');
  return Math.floor((d2 - d1) / 86400000);
}

function send(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * 員工查自己的出勤記錄（含補打卡標記）
 */
async function handleMyAttendance(url, res) {
  const lineUserId = url.searchParams.get('line_user_id');
  if (!lineUserId) return send(res, 400, { error: 'line_user_id required' });

  const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 31);
  const today = todayTpe();
  const startDate = new Date(new Date(today + 'T00:00:00+08:00').getTime() - (days - 1) * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

  // 驗證員工存在且為在職狀態
  const { rows: empRows } = await pool.query(
    'SELECT id, name, store_name FROM employees WHERE line_user_id = $1 AND is_active = true',
    [lineUserId]
  );
  if (empRows.length === 0) return send(res, 403, { error: '找不到員工或帳號未啟用' });
  const emp = empRows[0];

  // 取打卡記錄
  const { rows: records } = await pool.query(
    `SELECT cr.id, cr.check_type, cr.checked_at, cr.source, cr.note,
            cr.store_name,
            (SELECT json_agg(json_build_object(
              'old_time', ael.old_time, 'new_time', ael.new_time,
              'edit_reason', ael.edit_reason, 'edit_source', ael.edit_source,
              'editor_name', ael.editor_name, 'created_at', ael.created_at
            )) FROM attendance_edit_log ael WHERE ael.checkin_record_id = cr.id) AS edits
     FROM checkin_records cr
     WHERE cr.line_user_id = $1
       AND cr.checked_at >= ($2::date)
       AND cr.checked_at < ($3::date + interval '1 day')
       AND cr.check_type IN ('in', 'out')
     ORDER BY cr.checked_at ASC`,
    [lineUserId, startDate, today]
  );

  // 按日期分組
  const byDate = {};
  for (const r of records) {
    const dateStr = new Date(r.checked_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (!byDate[dateStr]) byDate[dateStr] = { date: dateStr, records: [] };
    const timeStr = new Date(r.checked_at).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit'
    });
    const isMakeup = r.source === 'employee_makeup' || r.source === 'makeup';
    const isManagerEdit = r.edits && r.edits.some(e => e.edit_source === 'manager_edit');
    byDate[dateStr].records.push({
      id: r.id,
      check_type: r.check_type,
      time: timeStr,
      checked_at: r.checked_at,
      source: r.source,
      store_name: r.store_name,
      is_makeup: isMakeup,
      is_edited: !!(r.edits && r.edits.length > 0),
      edits: r.edits || [],
    });
  }

  // 填充沒有記錄的日期
  const result = [];
  const cur = new Date(startDate + 'T00:00:00+08:00');
  const end = new Date(today + 'T00:00:00+08:00');
  while (cur <= end) {
    const d = cur.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    result.push(byDate[d] || { date: d, records: [] });
    cur.setDate(cur.getDate() + 1);
  }

  send(res, 200, {
    employee: { id: emp.id, name: emp.name, store_name: emp.store_name },
    days: result.reverse(), // 最近的日期在前
  });
}

/**
 * 員工自主補打卡
 */
async function handleMakeupPunch(bodyJson, res) {
  const { line_user_id, date, time, reason, edit_type, check_type } = bodyJson || {};

  // 基本參數驗證
  if (!line_user_id) return send(res, 400, { error: 'line_user_id required' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: '日期格式錯誤 (YYYY-MM-DD)' });
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return send(res, 400, { error: '時間格式錯誤 (HH:MM)' });
  if (!reason || reason.trim().length < 2) return send(res, 400, { error: '請填寫修改原因（至少2個字）' });
  if (!edit_type || !['add', 'edit'].includes(edit_type)) return send(res, 400, { error: 'edit_type 需為 add 或 edit' });

  // 驗證員工
  const { rows: empRows } = await pool.query(
    'SELECT id, name, store_name, line_user_id FROM employees WHERE line_user_id = $1 AND is_active = true',
    [line_user_id]
  );
  if (empRows.length === 0) return send(res, 403, { error: '找不到員工或帳號未啟用' });
  const emp = empRows[0];

  // 7天限制
  const today = todayTpe();
  const diff = daysBetween(date, today);
  if (diff < 0) return send(res, 400, { error: '不能補未來的打卡' });
  if (diff > 7) return send(res, 400, { error: '只能修改7天內的打卡記錄' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (edit_type === 'add') {
      // 新增補打卡 — 智慧判定 check_type
      // 查看當天已有的記錄
      const { rows: existing } = await client.query(
        `SELECT check_type FROM checkin_records
         WHERE line_user_id = $1 AND checked_at::date = $2 AND check_type IN ('in', 'out')
         ORDER BY checked_at`,
        [line_user_id, date]
      );
      
      let effectiveCheckType = check_type;
      if (!effectiveCheckType) {
        // 智慧判定：沒有 in 就補 in，有 in 沒 out 就補 out
        const hasIn = existing.some(r => r.check_type === 'in');
        const hasOut = existing.some(r => r.check_type === 'out');
        if (!hasIn) effectiveCheckType = 'in';
        else if (!hasOut) effectiveCheckType = 'out';
        else return send(res, 400, { error: '該日已有完整上下班記錄，請使用「修改」功能' });
      }

      // 檢查是否已有同類型記錄
      const hasSameType = existing.some(r => r.check_type === effectiveCheckType);
      if (hasSameType) {
        return send(res, 400, { error: `該日已有${effectiveCheckType === 'in' ? '上班' : '下班'}記錄，請使用「修改」功能` });
      }

      // 每天每個時段只能補一次的檢查
      const { rows: todayMakeups } = await client.query(
        `SELECT id FROM makeup_punches
         WHERE line_user_id = $1 AND punch_date = $2 AND check_type = $3
         AND created_at::date = CURRENT_DATE`,
        [line_user_id, date, effectiveCheckType]
      );
      if (todayMakeups.length > 0) {
        return send(res, 400, { error: '今天已補過該時段的打卡，每天每個時段只能補一次' });
      }

      // 插入打卡記錄
      const checkedAt = `${date}T${time}:00+08:00`;
      const { rows: inserted } = await client.query(
        `INSERT INTO checkin_records (line_user_id, employee_name, store_name, check_type, checked_at, source, note)
         VALUES ($1, $2, $3, $4, $5, 'employee_makeup', $6)
         RETURNING id`,
        [line_user_id, emp.name, emp.store_name, effectiveCheckType, checkedAt,
         `[補] ${reason}`]
      );
      const newRecordId = inserted[0].id;

      // 記錄到 makeup_punches
      await client.query(
        `INSERT INTO makeup_punches (employee_id, line_user_id, punch_date, punch_time, check_type, reason, status, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', NOW())`,
        [emp.id, line_user_id, date, time, effectiveCheckType, reason]
      );

      // 記錄到審計日誌
      await client.query(
        `INSERT INTO attendance_edit_log
         (checkin_record_id, employee_name, store_name, edit_date, check_type, old_time, new_time, edited_by, editor_name, edit_reason, edit_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'employee_makeup')`,
        [newRecordId, emp.name, emp.store_name, date, effectiveCheckType, '-', time, emp.id, emp.name, reason]
      );

      await client.query('COMMIT');
      send(res, 200, {
        ok: true,
        message: `已成功補登${effectiveCheckType === 'in' ? '上班' : '下班'}打卡`,
        record_id: newRecordId,
        check_type: effectiveCheckType,
        time,
      });

    } else if (edit_type === 'edit') {
      // 修改已有的打卡時間
      if (!check_type || !['in', 'out'].includes(check_type)) {
        return send(res, 400, { error: '修改模式需指定 check_type (in/out)' });
      }

      // 找到該員工該日該類型的打卡記錄
      const { rows: targetRows } = await client.query(
        `SELECT id, checked_at FROM checkin_records
         WHERE line_user_id = $1 AND checked_at::date = $2 AND check_type = $3
         ORDER BY checked_at DESC LIMIT 1`,
        [line_user_id, date, check_type]
      );
      if (targetRows.length === 0) {
        return send(res, 404, { error: `找不到該日的${check_type === 'in' ? '上班' : '下班'}記錄` });
      }

      const target = targetRows[0];
      const oldTime = new Date(target.checked_at).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit'
      });

      // 每天每個時段只能修改一次
      const { rows: todayEdits } = await client.query(
        `SELECT id FROM attendance_edit_log
         WHERE checkin_record_id = $1 AND edit_source = 'employee_makeup'
         AND created_at::date = CURRENT_DATE`,
        [target.id]
      );
      if (todayEdits.length > 0) {
        return send(res, 400, { error: '今天已修改過該時段，每天每個時段只能修改一次' });
      }

      // 更新打卡記錄
      const newCheckedAt = `${date}T${time}:00+08:00`;
      await client.query(
        `UPDATE checkin_records SET checked_at = $1, source = 'employee_makeup',
         note = COALESCE(note, '') || ' [補] ' || $2
         WHERE id = $3`,
        [newCheckedAt, reason, target.id]
      );

      // 記錄審計日誌
      await client.query(
        `INSERT INTO attendance_edit_log
         (checkin_record_id, employee_name, store_name, edit_date, check_type, old_time, new_time, edited_by, editor_name, edit_reason, edit_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'employee_makeup')`,
        [target.id, emp.name, emp.store_name, date, check_type, oldTime, time, emp.id, emp.name, reason]
      );

      // 同步到 makeup_punches
      await client.query(
        `INSERT INTO makeup_punches (employee_id, line_user_id, punch_date, punch_time, check_type, reason, status, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', NOW())`,
        [emp.id, line_user_id, date, time, check_type, reason]
      );

      await client.query('COMMIT');
      send(res, 200, {
        ok: true,
        message: `已成功修改${check_type === 'in' ? '上班' : '下班'}時間：${oldTime} → ${time}`,
        record_id: target.id,
        old_time: oldTime,
        new_time: time,
      });
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[makeup-punch] error:', e.message);
    send(res, 500, { error: '系統錯誤，請稍後再試' });
  } finally {
    client.release();
  }
}

/**
 * 店長查詢門市出勤（含補打卡標記）
 */
async function handleManagerAttendance(url, res) {
  const storeName = url.searchParams.get('store_name');
  const date = url.searchParams.get('date') || todayTpe();
  const editorLineUserId = url.searchParams.get('line_user_id');

  if (!storeName) return send(res, 400, { error: 'store_name required' });

  // 驗證店長權限
  if (editorLineUserId) {
    const { rows } = await pool.query(
      `SELECT is_manager, managed_store_names FROM employees
       WHERE line_user_id = $1 AND is_active = true`,
      [editorLineUserId]
    );
    if (rows.length === 0 || !rows[0].is_manager) {
      return send(res, 403, { error: '非管理員無權查看' });
    }
    const managed = rows[0].managed_store_names || [];
    if (managed.length > 0 && !managed.includes(storeName)) {
      return send(res, 403, { error: '無權查看該門市' });
    }
  }

  const { rows: records } = await pool.query(
    `SELECT cr.id, cr.line_user_id, cr.employee_name, cr.check_type, cr.checked_at,
            cr.source, cr.note,
            (SELECT json_agg(json_build_object(
              'old_time', ael.old_time, 'new_time', ael.new_time,
              'edit_reason', ael.edit_reason, 'edit_source', ael.edit_source,
              'editor_name', ael.editor_name, 'created_at', ael.created_at
            )) FROM attendance_edit_log ael WHERE ael.checkin_record_id = cr.id) AS edits
     FROM checkin_records cr
     WHERE cr.store_name = $1 AND cr.checked_at::date = $2
       AND cr.check_type IN ('in', 'out')
     ORDER BY cr.employee_name, cr.checked_at ASC`,
    [storeName, date]
  );

  // 按員工分組
  const byEmployee = {};
  for (const r of records) {
    const name = r.employee_name;
    if (!byEmployee[name]) byEmployee[name] = { name, line_user_id: r.line_user_id, records: [] };
    const timeStr = new Date(r.checked_at).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit'
    });
    byEmployee[name].records.push({
      id: r.id,
      check_type: r.check_type,
      time: timeStr,
      source: r.source,
      is_makeup: r.source === 'employee_makeup' || r.source === 'makeup',
      is_edited: !!(r.edits && r.edits.length > 0),
      edits: r.edits || [],
    });
  }

  send(res, 200, {
    store_name: storeName,
    date,
    employees: Object.values(byEmployee),
  });
}

/**
 * 店長編輯打卡時間
 */
async function handleManagerEdit(bodyJson, res) {
  const { checkin_record_id, new_time, reason, editor_line_user_id } = bodyJson || {};

  if (!checkin_record_id) return send(res, 400, { error: 'checkin_record_id required' });
  if (!new_time || !/^\d{2}:\d{2}$/.test(new_time)) return send(res, 400, { error: '時間格式錯誤 (HH:MM)' });
  if (!editor_line_user_id) return send(res, 400, { error: 'editor_line_user_id required' });

  // 驗證編輯者是店長
  const { rows: editorRows } = await pool.query(
    `SELECT id, name, is_manager, managed_store_names FROM employees
     WHERE line_user_id = $1 AND is_active = true`,
    [editor_line_user_id]
  );
  if (editorRows.length === 0 || !editorRows[0].is_manager) {
    return send(res, 403, { error: '非管理員無權編輯' });
  }
  const editor = editorRows[0];

  // 取得要編輯的記錄
  const { rows: targetRows } = await pool.query(
    'SELECT id, line_user_id, employee_name, store_name, check_type, checked_at FROM checkin_records WHERE id = $1',
    [checkin_record_id]
  );
  if (targetRows.length === 0) return send(res, 404, { error: '找不到該打卡記錄' });
  const target = targetRows[0];

  // 驗證店長管理範圍
  const managed = editor.managed_store_names || [];
  if (managed.length > 0 && !managed.includes(target.store_name)) {
    return send(res, 403, { error: '無權編輯該門市的記錄' });
  }

  const oldTime = new Date(target.checked_at).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit'
  });
  const dateStr = new Date(target.checked_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 更新打卡記錄
    const newCheckedAt = `${dateStr}T${new_time}:00+08:00`;
    await client.query(
      `UPDATE checkin_records SET checked_at = $1, source = 'manager_edit',
       note = COALESCE(note, '') || ' [店長修改] ' || COALESCE($2, '')
       WHERE id = $3`,
      [newCheckedAt, reason || '', target.id]
    );

    // 審計日誌
    await client.query(
      `INSERT INTO attendance_edit_log
       (checkin_record_id, employee_name, store_name, edit_date, check_type, old_time, new_time, edited_by, editor_name, edit_reason, edit_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manager_edit')`,
      [target.id, target.employee_name, target.store_name, dateStr, target.check_type, oldTime, new_time, editor.id, editor.name, reason || '']
    );

    await client.query('COMMIT');
    send(res, 200, {
      ok: true,
      message: `已修改 ${target.employee_name} 的${target.check_type === 'in' ? '上班' : '下班'}時間：${oldTime} → ${new_time}`,
      old_time: oldTime,
      new_time: new_time,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[manager-edit] error:', e.message);
    send(res, 500, { error: '系統錯誤' });
  } finally {
    client.release();
  }
}

/**
 * 補打卡審計紀錄
 */
async function handleMakeupLog(url, res) {
  const storeName = url.searchParams.get('store_name');
  const month = url.searchParams.get('month'); // YYYY-MM
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);

  let query = `
    SELECT ael.*, cr.source AS record_source
    FROM attendance_edit_log ael
    LEFT JOIN checkin_records cr ON cr.id = ael.checkin_record_id
    WHERE 1=1
  `;
  const params = [];
  let paramIdx = 1;

  if (storeName) {
    query += ` AND ael.store_name = $${paramIdx++}`;
    params.push(storeName);
  }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    query += ` AND ael.edit_date >= $${paramIdx++}::date AND ael.edit_date < ($${paramIdx++}::date + interval '1 month')`;
    params.push(`${month}-01`, `${month}-01`);
  }
  query += ` ORDER BY ael.created_at DESC LIMIT $${paramIdx++}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);

  send(res, 200, {
    logs: rows.map(r => ({
      id: r.id,
      employee_name: r.employee_name,
      store_name: r.store_name,
      edit_date: r.edit_date,
      check_type: r.check_type,
      old_time: r.old_time || '-',
      new_time: r.new_time,
      editor_name: r.editor_name,
      edit_reason: r.edit_reason || '',
      edit_source: r.edit_source || 'manager_edit',
      record_source: r.record_source,
      created_at: r.created_at,
    })),
  });
}

/**
 * 查詢某筆打卡的編輯歷程
 */
async function handleEditDetails(url, res) {
  const recordId = url.searchParams.get('checkin_record_id');
  if (!recordId) return send(res, 400, { error: 'checkin_record_id required' });

  const { rows } = await pool.query(
    `SELECT * FROM attendance_edit_log WHERE checkin_record_id = $1 ORDER BY created_at ASC`,
    [recordId]
  );

  send(res, 200, { edits: rows });
}

/**
 * 主路由
 */
export async function handleEmployeeAttendanceApi(req, res, { url, bodyJson }) {
  const action = url.searchParams.get('action');

  try {
    switch (action) {
      case 'my-attendance':
        return await handleMyAttendance(url, res);
      case 'makeup-punch':
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
        return await handleMakeupPunch(bodyJson, res);
      case 'manager-attendance':
        return await handleManagerAttendance(url, res);
      case 'manager-edit':
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
        return await handleManagerEdit(bodyJson, res);
      case 'makeup-log':
        return await handleMakeupLog(url, res);
      case 'edit-details':
        return await handleEditDetails(url, res);
      default:
        return send(res, 400, { error: `Unknown action: ${action}`, available: ['my-attendance', 'makeup-punch', 'manager-attendance', 'manager-edit', 'makeup-log', 'edit-details'] });
    }
  } catch (e) {
    console.error('[employee-attendance-api] error:', e.message, e.stack);
    send(res, 500, { error: '系統錯誤，請稍後再試' });
  }
}
