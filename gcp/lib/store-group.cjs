/**
 * store-group.cjs — 查找門市 LINE 群組 ID
 *
 * 統一查找邏輯：
 *   1. odoo_id 直配（partner_id → stores.odoo_id）
 *   2. Odoo parent_id / commercial_partner_id 回查
 *   3. 名稱模糊比對（partner_name 中文關鍵字 → stores.store_name）
 *
 * Usage:
 *   const { StoreGroupResolver } = require('../lib/store-group.cjs');
 *   const resolver = new StoreGroupResolver(pool);
 *   await resolver.init();
 *   const result = resolver.resolve(partnerId, partnerName);
 *   // result = { groupId, storeName } | null
 */

const { odooCall } = require('./odoo.cjs');

class StoreGroupResolver {
  constructor(pool) {
    this.pool = pool;
    this.partnerToGroup = {};    // odoo_id → { groupId, storeName }
    this.allStoresWithGroup = []; // [{ id, store_name, line_group_id }]
    this._initialized = false;
  }

  /**
   * 載入 DB 資料（必須在使用前呼叫一次）
   */
  async init() {
    // 1. odoo_id → group mapping
    const { rows: storePayees } = await this.pool.query(`
      SELECT s.odoo_id AS odoo_partner_id,
             COALESCE(
               NULLIF(p_direct.line_group_id, ''),
               NULLIF(p_assoc.line_group_id, ''),
               s.line_group_id
             ) AS line_group_id,
             s.store_name
      FROM stores s
      LEFT JOIN payees p_direct ON p_direct.store_id = s.id
      LEFT JOIN payees p_assoc ON p_assoc.id = s.payee_id
      WHERE s.odoo_id IS NOT NULL
        AND (
          (p_direct.line_group_id IS NOT NULL AND p_direct.line_group_id != '')
          OR (p_assoc.line_group_id IS NOT NULL AND p_assoc.line_group_id != '')
          OR (s.line_group_id IS NOT NULL AND s.line_group_id != '')
        )
    `);
    this.partnerToGroup = {};
    for (const sp of storePayees) {
      this.partnerToGroup[sp.odoo_partner_id] = {
        groupId: sp.line_group_id,
        storeName: sp.store_name
      };
    }

    // 2. 全部有 group 的店家（供名稱比對）
    const { rows } = await this.pool.query(`
      SELECT s.id, s.store_name,
             COALESCE(
               NULLIF(p_direct.line_group_id, ''),
               NULLIF(p_assoc.line_group_id, ''),
               s.line_group_id
             ) AS line_group_id
      FROM stores s
      LEFT JOIN payees p_direct ON p_direct.store_id = s.id
      LEFT JOIN payees p_assoc ON p_assoc.id = s.payee_id
      WHERE (
        (p_direct.line_group_id IS NOT NULL AND p_direct.line_group_id != '')
        OR (p_assoc.line_group_id IS NOT NULL AND p_assoc.line_group_id != '')
        OR (s.line_group_id IS NOT NULL AND s.line_group_id != '')
      )
    `);
    this.allStoresWithGroup = rows;
    this._initialized = true;

    console.log(`[store-group] ✅ 載入 ${Object.keys(this.partnerToGroup).length} 筆 odoo mapping, ${rows.length} 家有群組的店`);
  }

  /**
   * 用 partner_id 直接查（步驟 1）
   */
  resolveByOdooId(partnerId) {
    return this.partnerToGroup[partnerId] || null;
  }

  /**
   * 用名稱模糊比對（步驟 3）
   * @param {string} partnerName - Odoo partner 名稱，如 "泡泡貓忠孝店, Kelly"
   * @returns {{ groupId, storeName } | null}
   */
  resolveByName(partnerName) {
    if (!partnerName) return null;
    const cleaned = partnerName.replace(/泡泡貓[｜|]?/g, '').trim();

    // 嘗試完整比對
    for (const s of this.allStoresWithGroup) {
      const sName = s.store_name.replace(/泡泡貓[｜|]?/g, '').trim();
      if (sName && cleaned && (sName.includes(cleaned) || cleaned.includes(sName))) {
        return { groupId: s.line_group_id, storeName: s.store_name };
      }
    }

    // 寬鬆比對：取中文段逐一匹配
    const segments = cleaned.match(/[\u4e00-\u9fff]+/g) || [];
    for (const seg of segments) {
      if (seg.length < 2) continue;
      for (const s of this.allStoresWithGroup) {
        if (s.store_name.includes(seg)) {
          return { groupId: s.line_group_id, storeName: s.store_name };
        }
      }
    }

    return null;
  }

  /**
   * 完整查找：odoo_id → parent_id → 名稱比對
   * @param {number} partnerId - Odoo partner ID
   * @param {string} partnerName - Odoo partner 顯示名稱
   * @returns {Promise<{ groupId, storeName, method: 'odoo_id'|'parent_id'|'name' } | null>}
   */
  async resolve(partnerId, partnerName) {
    if (!this._initialized) throw new Error('StoreGroupResolver not initialized. Call init() first.');

    // 步驟 1: odoo_id 直配
    const direct = this.resolveByOdooId(partnerId);
    if (direct) return { ...direct, method: 'odoo_id' };

    // 步驟 2: Odoo parent_id / commercial_partner_id
    try {
      const partners = await odooCall('res.partner', 'read', [[partnerId]],
        { fields: ['id', 'parent_id', 'commercial_partner_id'] }
      );
      if (partners && partners[0]) {
        const p = partners[0];
        const parentId = p.commercial_partner_id?.[0] || p.parent_id?.[0];
        if (parentId && parentId !== p.id) {
          const parentMatch = this.resolveByOdooId(parentId);
          if (parentMatch) return { ...parentMatch, method: 'parent_id' };
        }
      }
    } catch (e) {
      console.warn(`[store-group] ⚠️ Odoo parent_id 查詢失敗 (partner ${partnerId}): ${e.message}`);
    }

    // 步驟 3: 名稱模糊比對
    const nameMatch = this.resolveByName(partnerName);
    if (nameMatch) return { ...nameMatch, method: 'name' };

    return null;
  }

  /**
   * 批次查找（減少 Odoo API 呼叫）
   * @param {Array<{partnerId, partnerName}>} items
   * @returns {Promise<Map<number, { groupId, storeName, method }>>}
   */
  async resolveBatch(items) {
    if (!this._initialized) throw new Error('StoreGroupResolver not initialized. Call init() first.');

    const results = new Map();
    const needParentLookup = []; // 需要查 Odoo parent_id 的

    // 步驟 1: 批量 odoo_id 直配
    for (const item of items) {
      const direct = this.resolveByOdooId(item.partnerId);
      if (direct) {
        results.set(item.partnerId, { ...direct, method: 'odoo_id' });
      } else {
        needParentLookup.push(item);
      }
    }

    if (needParentLookup.length === 0) return results;

    // 步驟 2: 批量查 Odoo parent_id
    const unmatchedIds = [...new Set(needParentLookup.map(i => i.partnerId).filter(Boolean))];
    const partnerParentMap = {};
    try {
      const partners = await odooCall('res.partner', 'read', [unmatchedIds],
        { fields: ['id', 'parent_id', 'commercial_partner_id'] }
      );
      for (const p of partners) {
        const parentId = p.commercial_partner_id?.[0] || p.parent_id?.[0];
        if (parentId && parentId !== p.id) {
          partnerParentMap[p.id] = parentId;
        }
      }
    } catch (e) {
      console.warn(`[store-group] ⚠️ 批量 Odoo parent_id 查詢失敗: ${e.message}`);
    }

    // 步驟 2+3: parent_id 比對 + 名稱 fallback
    for (const item of needParentLookup) {
      const parentId = partnerParentMap[item.partnerId];
      if (parentId) {
        const parentMatch = this.resolveByOdooId(parentId);
        if (parentMatch) {
          results.set(item.partnerId, { ...parentMatch, method: 'parent_id' });
          continue;
        }
      }

      const nameMatch = this.resolveByName(item.partnerName);
      if (nameMatch) {
        results.set(item.partnerId, { ...nameMatch, method: 'name' });
      }
    }

    return results;
  }
}

module.exports = { StoreGroupResolver };
