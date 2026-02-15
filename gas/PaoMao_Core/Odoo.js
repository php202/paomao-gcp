// Odoo.gs

// 解析 Odoo URL
function parseOdooUrl(url) {
  try {
    const matchModel = url.match(/model=([^&]+)/);
    const matchId = url.match(/res_id=([^&]+)/);
    if (matchModel && matchId) return { model: matchModel[1], res_id: matchId[1] };
    return null;
  } catch (e) { return null; }
}

// 抓取 Sale Order (用於正數/收款)
function getOdooSaleOrderJSON(resId) {
  return fetchOdooData(
    'sale.order.line', 
    [['order_id', '=', parseInt(resId)], ['display_type', '=', false]], 
    ['name', 'product_uom_qty', 'price_subtotal']
  );
}

// 抓取 Account Move (用於負數/付款) - 修正版
function getOdooInvoiceJSON(resId) {
  // --- 第一步：嘗試抓取商品明細 (Bill/Invoice) ---
  // 修正：移除 exclude_from_invoice_tab，改用 display_type = 'product'
  let lines = fetchOdooData(
    'account.move.line', 
    [
      ['move_id', '=', parseInt(resId)], 
      ['display_type', '=', 'product'] // 只抓商品行
    ], 
    ['name', 'quantity', 'price_subtotal']
  );

  // 如果抓得到明細，直接回傳
  if (lines && lines.length > 0) {
    return lines;
  }

  // --- 第二步：如果抓不到明細 (代表是 Payment 付款單) ---
  // 我們需要另外去讀取「主表 (account.move)」來拿總金額
  console.log(`單據 ${resId} 無商品明細，嘗試讀取總金額 (視為付款單)...`);
  
  const odoo = getOdooConfig();
  const url = `${odoo.url}/jsonrpc`;
  try {
    // 1. 登入 (Authenticate)
    const authBody = {
      jsonrpc: "2.0", method: "call",
      params: {
        service: "common", method: "authenticate",
        args: [odoo.db, odoo.username, odoo.password, {}]
      }
    };
    const resAuth = UrlFetchApp.fetch(url, {method:"post", contentType:"application/json", payload:JSON.stringify(authBody)});
    const uid = JSON.parse(resAuth.getContentText()).result;

    if (!uid) return [];

    // 2. 讀取主表 Header
    const readBody = {
      jsonrpc: "2.0", method: "call",
      params: {
        service: "object", method: "execute_kw",
        args: [
          odoo.db, uid, odoo.password,
          'account.move', 'read',
          [parseInt(resId)], 
          ['name', 'ref', 'amount_total', 'payment_state'] 
        ]
      }
    };
    const res = UrlFetchApp.fetch(url, {method: "post", contentType: "application/json", payload: JSON.stringify(readBody)});
    const result = JSON.parse(res.getContentText()).result;

    if (result && result.length > 0) {
      const doc = result[0];
      // 手動建構一個「假明細」回傳
      return [{
        name: `付款單/單據: ${doc.ref || doc.name || '無編號'}`,
        quantity: 1,
        price_subtotal: doc.amount_total || 0
      }];
    }
  } catch (e) {
    console.error("讀取 Payment Header 失敗: " + e.message);
  }

  return [];
}
// 通用查詢器 (含錯誤處理)
function fetchOdooData(modelName, domain, fields) {
  const odoo = getOdooConfig();
  const url = `${odoo.url}/jsonrpc`;
  try {
    // 1. 登入
    const authBody = {
      jsonrpc: "2.0", method: "call",
      params: {
        service: "common", method: "authenticate",
        args: [odoo.db, odoo.username, odoo.password, {}]
      }
    };
    const resAuth = UrlFetchApp.fetch(url, {method:"post", contentType:"application/json", payload:JSON.stringify(authBody)});
    const uid = JSON.parse(resAuth.getContentText()).result;

    if (!uid) {
      console.error("Odoo 登入失敗：無法取得 UID");
      return [];
    }

    // 2. 搜尋
    const searchBody = {
      jsonrpc: "2.0", method: "call",
      params: {
        service: "object", method: "execute_kw",
        args: [
          odoo.db, uid, odoo.password,
          modelName, 'search_read',
          [domain], // 搜尋條件
          { fields: fields } // 指定欄位
        ]
      }
    };
    
    const res = UrlFetchApp.fetch(url, {method: "post", contentType: "application/json", payload: JSON.stringify(searchBody)});
    const json = JSON.parse(res.getContentText());

    // --- 關鍵修正：檢查是否有錯誤 ---
    if (json.error) {
      console.error(`Odoo 查詢錯誤 (${modelName}):`, JSON.stringify(json.error, null, 2));
      return []; // 有錯誤就回傳空陣列，不要讓程式崩潰
    }

    if (!json.result) {
      console.error(`Odoo 回傳結果為空 (${modelName})`);
      return [];
    }

    // 成功取得資料，開始格式化
    return json.result.map(line => ({
      name: line.name ? String(line.name).split('\n')[0] : "無名稱",
      quantity: line.quantity || line.product_uom_qty || 0,
      price_subtotal: line.price_subtotal || 0
    }));

  } catch (e) {
    console.error("fetchOdooData 系統錯誤: " + e.message);
    return [];
  }
}
