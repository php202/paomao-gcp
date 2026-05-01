const pg = require('pg');
const { odooCall } = require('../lib/odoo.cjs');
const pool = new pg.Pool({ database: 'paomao', host: 'localhost', port: 5432 });

(async () => {
  // ACH records for 2026-03 儲值金
  const { rows: achRows } = await pool.query(`
    SELECT store_name, amount, odoo_quote_id, description, status
    FROM ach_records 
    WHERE fee_type = '儲值金' AND description LIKE '2026-03%'
    ORDER BY store_name
  `);
  
  // Odoo SO for 2026-03 (product 28)
  const orders = await odooCall('sale.order', 'search_read',
    [[['date_order', '>=', '2026-03-01'], ['date_order', '<', '2026-04-01'], 
      ['order_line.product_id', '=', 28]]],
    { fields: ['name', 'partner_id', 'amount_total', 'state'], limit: 100 }
  );

  const odooMap = {};
  orders.forEach(o => { odooMap[o.partner_id[1]] = o; });

  console.log('=== 2026-03 儲值金：ACH vs Odoo SO ===\n');
  console.log('門市'.padEnd(22) + 'ACH金額'.padStart(10) + '  SO金額'.padStart(10) + '  SO單號'.padStart(10) + '  相符');
  console.log('-'.repeat(75));

  let totalAch = 0, totalOdoo = 0, issues = [];

  for (const ach of achRows) {
    const achAmt = parseFloat(ach.amount);
    totalAch += achAmt;
    const odoo = odooMap[ach.store_name];
    const odooAmt = odoo ? odoo.amount_total : null;
    if (odoo) totalOdoo += odooAmt;
    
    const shortStore = ach.store_name.replace('泡泡貓｜', '');
    const match = odooAmt !== null && Math.abs(achAmt - odooAmt) < 2;
    
    console.log(
      shortStore.padEnd(18) +
      achAmt.toFixed(0).padStart(10) +
      (odooAmt !== null ? odooAmt.toFixed(0) : 'N/A').padStart(10) +
      (odoo ? odoo.name : 'N/A').padStart(10) +
      (match ? '  ✅' : odooAmt === null ? '  ❓ 無SO' : '  ⚠️ 差異: ' + (odooAmt - achAmt).toFixed(0))
    );
    
    if (!match && odooAmt !== null) issues.push(`${shortStore}: ACH=${achAmt} vs SO=${odooAmt} (差=${odooAmt - achAmt})`);
    if (odooAmt === null) issues.push(`${shortStore}: ACH有 但 Odoo無SO`);
  }

  // Check Odoo has SO but ACH doesn't
  const achStores = new Set(achRows.map(r => r.store_name));
  for (const [store, o] of Object.entries(odooMap)) {
    if (!achStores.has(store)) {
      issues.push(`${store.replace('泡泡貓｜', '')}: Odoo有SO(${o.name}=$${o.amount_total}) 但 ACH無記錄`);
    }
  }

  console.log('-'.repeat(75));
  console.log('ACH 合計:'.padEnd(18) + totalAch.toFixed(0).padStart(10));
  console.log('Odoo 合計:'.padEnd(18) + totalOdoo.toFixed(0).padStart(10));

  if (issues.length) {
    console.log('\n⚠️ 差異:');
    issues.forEach(i => console.log('  ' + i));
  } else {
    console.log('\n✅ ACH 與 Odoo SO 金額全部一致！');
  }

  await pool.end();
})();
