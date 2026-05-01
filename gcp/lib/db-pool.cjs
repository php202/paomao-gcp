/**
 * 統一的資料庫連線池模組
 * 避免 getPool is not defined 錯誤
 */

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/paomao';
let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({ 
      connectionString: DB_URL, 
      max: 10,
      host: '/tmp', // Unix socket
      database: 'paomao',
      user: 'paopaomao'
    });
  }
  return _pool;
}

async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  getPool,
  query,
  closePool
};