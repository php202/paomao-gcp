/**
 * lib/ach.js — 統一 ACH 操作模組（ESM）
 *
 * 提供 ach_records DB 查詢/更新的共用操作
 * 供 scripts 和 api 統一 import
 *
 * exports:
 *   getUnconfirmedAchRecords(year?)
 *   getAchRecordById(id)
 *   updateAchConfirmed(id, confirmedAt?)
 *   insertAchRecord(record)
 *   getPayeeByCode(code)
 *   getPayees()
 */

import pool from './db.js';

const DEFAULT_YEAR = new Date().getFullYear();

/**
 * 查詢未確認的 ACH 紀錄（customer_confirmed IS NULL）
 * @param {number} [year]
 * @returns {Promise<Array>}
 */
export async function getUnconfirmedAchRecords(year = DEFAULT_YEAR) {
  const { rows } = await pool.query(
    `SELECT ar.*, p.line_group_id, p.account_name, p.bank_account
     FROM ach_records ar
     LEFT JOIN payees p ON ar.payee_code = p.code
     WHERE ar.year = $1
       AND (ar.customer_confirmed IS NULL OR ar.customer_confirmed = '')
       AND ar.odoo_quote_id IS NOT NULL AND ar.odoo_quote_id != ''
     ORDER BY ar.id ASC`,
    [year]
  );
  return rows;
}

/**
 * 依 id 查詢 ACH 紀錄
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getAchRecordById(id) {
  const { rows } = await pool.query(
    `SELECT ar.*, p.line_group_id, p.account_name, p.bank_account
     FROM ach_records ar
     LEFT JOIN payees p ON ar.payee_code = p.code
     WHERE ar.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * 更新客戶確認時間
 * @param {number} id
 * @param {string} [confirmedAt] - ISO 時間字串，預設 NOW()
 */
export async function updateAchConfirmed(id, confirmedAt = null) {
  if (confirmedAt) {
    await pool.query(
      `UPDATE ach_records SET customer_confirmed = $1, updated_at = NOW() WHERE id = $2`,
      [confirmedAt, id]
    );
  } else {
    await pool.query(
      `UPDATE ach_records SET customer_confirmed = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }
}

/**
 * 新增 ACH 紀錄
 * @param {object} record - 欄位物件
 * @returns {Promise<number>} 新紀錄 id
 */
export async function insertAchRecord(record) {
  const {
    year = DEFAULT_YEAR,
    payee_code = '',
    amount = 0,
    odoo_quote_id = null,
    fee_type = '',
    note = '',
    sheet_row = null,
  } = record;
  const { rows } = await pool.query(
    `INSERT INTO ach_records (year, payee_code, amount, odoo_quote_id, fee_type, note, sheet_row)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [year, payee_code, amount, odoo_quote_id, fee_type, note, sheet_row]
  );
  return rows[0].id;
}

/**
 * 查詢單一 payee
 * @param {string} code
 * @returns {Promise<object|null>}
 */
export async function getPayeeByCode(code) {
  const { rows } = await pool.query(
    `SELECT * FROM payees WHERE code = $1 LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

/**
 * 查詢所有 active payees
 * @returns {Promise<Array>}
 */
export async function getPayees() {
  const { rows } = await pool.query(
    `SELECT * FROM payees WHERE is_active = TRUE ORDER BY code`
  );
  return rows;
}
