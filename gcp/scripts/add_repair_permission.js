#!/usr/bin/env node
/**
 * 為 admin 角色添加維修系統權限
 */

import { Pool } from 'pg';

const pool = new Pool({ database: 'paomao', host: 'localhost', port: 5432, max: 5 });

async function addRepairPermission() {
  try {
    console.log('🔧 開始為 admin 角色添加維修權限...');
    
    // 取得當前 admin 角色權限
    const { rows } = await pool.query('SELECT permissions FROM roles WHERE role_name = $1', ['admin']);
    
    if (rows.length === 0) {
      console.log('❌ 找不到 admin 角色');
      return;
    }
    
    const currentPermissions = rows[0].permissions;
    console.log('📋 當前權限:', Object.keys(currentPermissions).join(', '));
    
    // 添加維修權限
    currentPermissions.repair = {
      view: true,
      edit: true,
      description: '維修系統管理權限'
    };
    
    // 更新資料庫
    await pool.query(
      'UPDATE roles SET permissions = $1 WHERE role_name = $2',
      [JSON.stringify(currentPermissions), 'admin']
    );
    
    console.log('✅ 成功為 admin 角色添加 repair 權限');
    console.log('📋 新權限:', Object.keys(currentPermissions).join(', '));
    
  } catch (error) {
    console.error('❌ 添加權限失敗:', error.message);
  } finally {
    await pool.end();
  }
}

addRepairPermission();