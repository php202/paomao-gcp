const pg = require('pg');
const { odooCall } = require('../lib/odoo.cjs');
const pool = new pg.Pool({ database: 'paomao', host: 'localhost', port: 5432 });

function shortName(s) {
  return (s || '').replace(/泡泡貓[｜|]/g, '').replace(/店$/, '').trim();
}

(async () => {
  const { rows: achRows } = await pool.query(`
    SELECT store_name, amount, odoo_quote_id, description, status
    FROM ach_records 
    WHERE fee_type = '儲值金' AND description LIKE '2026-03%'
    ORDER BY store_name
  `);
  
  const orders = await odooCall('sale.order', 'search_read',
    [[['date_order', '>=', '2026-03-01'], ['date_order', '<', '2026-04-01'], 
      ['order_line.product_id', '=', 28]]],
    { fields: ['name', 'partner_id', 'amount_total', 'state'], limit: 100 }
  );

  // Build map by short name
  const odooMap = {};
  orders.forEach(o => { odooMap[shortName(o.partner_id[1])] = o; });

  console.log('=== 2026-03 儲值金：ACH vs Odoo SO（短名匹配）===\n');
  console.log('門市'.padEnd(16) + 'ACH金額'.padStart(10) + '  Odoo SO'.padStart(10) + '   差額'.padStart(8) + '  SO單號'.padStart(10) + '  狀態');
  console.log('-'.repeat(80));

  let totalAch = 0, totalOdoo = 0, matchCount = 0, diffCount = 0;

  for (const ach of achRows) {
    const achAmt = parseFloat(ach.amount);
    totalAch += achAmt;
    const sn = shortName(ach.store_name);
    const odoo = odooMap[sn];
    const odooAmt = odoo ? odoo.amount_total : null;
    if (odoo) totalOdoo += odooAmt;
    
    const diff = odooAmt !== null ? odooAmt - achAmt : null;
    const match = diff !== null && Math.abs(diff) < 2;
    if (match) matchCount++;
    else if (diff !== null) diffCount++;
    
    console.log(
      sn.padEnd(14) +
      achAmt.toFixed(0).padStart(10) +
      (odooAmt !== null ? odooAmt.toFixed(0) : 'N/A').padStart(10) +
      (diff !== null ? (diff > 0 ? '+' : '') + diff.toFixed(0) : '-').padStart(8) +
      (odoo ? odoo.name : '-').padStart(10) +
      (match ? '  ✅' : odooAmt === null ? '  ❓ 無SO' : '  ⚠️')
    );
  }

  // Odoo SO without ACH
  const achShortNames = new Set(achRows.map(r => shortName(r.store_name)));
  for (const [sn, o] of Object.entries(odooMap)) {
    if (!achShortNames.has(sn)) {
      console.log(`${sn.padEnd(14)}${'N/A'.padStart(10)}${o.amount_total.toFixed(0).padStart(10)}${''.padStart(8)}${o.name.padStart(10)}  ❓ ACH無`);
    }
  }

  console.log('-'.repeat(80));
  console.log(`ACH 合計: ${totalAch.toFixed(0)}  |  Odoo 合計: ${totalOdoo.toFixed(0)}  |  差: ${(totalOdoo - totalAch).toFixed(0)}`);
  console.log(`✅ 一致: ${matchCount}  |  ⚠️ 差異: ${diffCount}  |  ❓ 無SO: ${achRows.length - matchCount - diffCount}`);

  await pool.end();
})();
