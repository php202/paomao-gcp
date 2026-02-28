/**
 * PostgreSQL 連線池 — 泡泡貓本機 DB
 * DB: paomao, Host: localhost, Port: 5432
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  database: 'paomao',
  host: 'localhost',
  port: 5432,
  max: 10,
  idleTimeoutMillis: 30000,
});

export default pool;

/**
 * 驗證員工是否有打卡權限（取代 Sheet readSheet 員工清單）
 * @returns {{ isAuthorized, identity[], managedStores[], workStores[], employeeCode, name }}
 */
export async function isUserAuthorizedDB(userId) {
  const result = {
    isAuthorized: false,
    identity: [],
    managedStores: [],
    workStores: [],
    employeeCode: '',
    name: '',
    sheetError: false,
  };
  if (!userId) return result;

  try {
    const { rows } = await pool.query(
      `SELECT name, store_name, title, saydou_store_id, employee_code, is_active, is_manager, managed_stores
       FROM employees WHERE line_user_id = $1`,
      [userId]
    );
    if (rows.length === 0) return result;

    const emp = rows[0];
    if (!emp.is_active && emp.title === '離職') return result;

    result.isAuthorized = true;
    result.name = emp.name || '';
    result.employeeCode = emp.employee_code || '';
    if (emp.saydou_store_id) result.workStores.push(emp.saydou_store_id);
    if (emp.store_name) result.workStores.push(emp.store_name);

    result.identity.push('employee');
    if (emp.is_manager) {
      result.identity.push('manager');
      result.managedStores = emp.managed_stores || [];
    }
  } catch (e) {
    console.error('[db] isUserAuthorizedDB error:', e.message);
    result.sheetError = true;
  }
  return result;
}

/**
 * 寫入打卡紀錄到 DB（取代 appendSheet 員工打卡紀錄）
 */
export async function logCheckInDB(userId, uuid, frontUuid, checkType = 'in', lat = null, lng = null) {
  try {
    // Get employee name
    const { rows } = await pool.query('SELECT name, store_name FROM employees WHERE line_user_id = $1', [userId]);
    const name = rows[0]?.name || '';
    const store = rows[0]?.store_name || '';

    await pool.query(
      `INSERT INTO checkin_records (line_user_id, employee_name, store_name, check_type, latitude, longitude, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, 'line', $7)`,
      [userId, name, store, checkType, lat, lng, `uuid:${uuid}`]
    );
    return true;
  } catch (e) {
    console.error('[db] logCheckInDB error:', e.message);
    return false;
  }
}

/**
 * 儲存打卡綁定
 */
export async function saveBindingDB(userId, uuid, frontUuid) {
  try {
    await pool.query(
      'INSERT INTO checkin_bindings (line_user_id, uuid, front_uuid) VALUES ($1, $2, $3)',
      [userId, uuid, frontUuid]
    );
    return true;
  } catch (e) {
    console.error('[db] saveBindingDB error:', e.message);
    return false;
  }
}

/**
 * 查詢員工本月打卡紀錄（取代產出 Google Sheet 出勤表）
 */
export async function getAttendanceRecords(userId, year, month) {
  const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2,'0')}-01`;

  const { rows } = await pool.query(
    `SELECT checked_at, check_type, latitude, longitude, note
     FROM checkin_records
     WHERE line_user_id = $1 AND checked_at >= $2 AND checked_at < $3
     ORDER BY checked_at ASC`,
    [userId, startDate, endDate]
  );
  return rows;
}

/**
 * 註冊申請寫入 DB
 */
export async function saveRegisterRequest(userId, displayName, message) {
  try {
    await pool.query(
      `INSERT INTO employees (line_user_id, name, title, is_active)
       VALUES ($1, $2, '待審核', FALSE)
       ON CONFLICT (line_user_id) DO UPDATE SET name = EXCLUDED.name, title = '待審核', updated_at = NOW()`,
      [userId, displayName || '']
    );
    return true;
  } catch (e) {
    console.error('[db] saveRegisterRequest error:', e.message);
    return false;
  }
}
