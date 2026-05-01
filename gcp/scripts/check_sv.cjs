const { Pool } = require('pg');
const { odooCall } = require('../lib/odoo.cjs');
const p = new Pool({ database: 'paomao', host: 'localhost', port: 5432 });

(async () => {
  // SayDou: 各店 2026-03 儲值金(rpcash) 和 儲值消費(ticket)
  const { rows: saydou } = await p.query(`
    SELECT store_name, 
           SUM(rpcash::numeric) as sv_deposit,
           SUM(ticket::numeric) as sv_consume
    FROM saydou_transactions 
    WHERE year_month = '2026-03' AND is_deleted = false
    GROUP BY store_name
    ORDER BY store_name
  `);

  // Odoo: 各店 2026-03 儲值金 SO
  const orders = await odooCall('sale.order', 'search_read',
    [[['date_order', '>=', '2026-03-01'], ['date_order', '<', '2026-04-01'], 
      ['order_line.product_id', '=', 28]]],
    { fields: ['name', 'partner_id', 'order_line'], limit: 100 }
  );
  const allLineIds = orders.flatMap(o => o.order_line);
  const lines = await odooCall('sale.order.line', 'search_read',
    [[['id', 'in', allLineIds]]],
    { fields: ['order_id', 'product_id', 'price_subtotal'], limit: 500 }
  );

  // Build Odoo map: store -> { deposit, consume, coupon, product_coupon }
  const odooMap = {};
  for (const o of orders) {
    const store = o.partner_id[1];
    if (!odooMap[store]) odooMap[store] = { deposit: 0, consume: 0, coupon: 0, product: 0, name: '' };
    odooMap[store].name = o.name;
    const oLines = lines.filter(l => l.order_id[0] === o.id);
    for (const l of oLines) {
      const pid = l.product_id[0];
      if (pid === 28) odooMap[store].deposit += l.price_subtotal;
      else if (pid === 727) odooMap[store].consume += l.price_subtotal;
      else if (pid === 726) odooMap[store].coupon += l.price_subtotal;
      else if (pid === 728) odooMap[store].product += l.price_subtotal;
    }
  }

  // Compare
  console.log('=== 2026-03 儲值金對比（SayDou vs Odoo）===\n');
  console.log('門市'.padEnd(22) + '  SO   ' + ' SayDou儲值' + '  Odoo儲值 ' + '  差異  ' + ' | SayDou消費' + '  Odoo消費 ' + '  差異');
  console.log('-'.repeat(110));

  let totalSayDeposit = 0, totalOdooDeposit = 0, totalSayConsume = 0, totalOdooConsume = 0;
  let issues = [];

  for (const [store, odoo] of Object.entries(odooMap).sort((a,b) => a[0].localeCompare(b[0]))) {
    const say = saydou.find(s => s.store_name === store);
    const sayDep = say ? parseFloat(say.sv_deposit) : 0;
    const sayCon = say ? parseFloat(say.sv_consume) : 0;
    const depDiff = odoo.deposit - sayDep;
    const conDiff = Math.abs(odoo.consume) - sayCon;

    totalSayDeposit += sayDep;
    totalOdooDeposit += odoo.deposit;
    totalSayConsume += sayCon;
    totalOdooConsume += Math.abs(odoo.consume);

    const shortStore = store.replace('泡泡貓｜', '');
    const depFlag = Math.abs(depDiff) > 1 ? '⚠️' : '✅';
    const conFlag = Math.abs(conDiff) > 1 ? '⚠️' : '✅';
    
    console.log(
      shortStore.padEnd(16) +
      odoo.name.padStart(8) +
      sayDep.toFixed(0).padStart(10) +
      odoo.deposit.toFixed(0).padStart(10) +
      ((depDiff > 0 ? '+' : '') + depDiff.toFixed(0)).padStart(8) + depFlag +
      ' | ' +
      sayCon.toFixed(0).padStart(10) +
      Math.abs(odoo.consume).toFixed(0).padStart(10) +
      ((conDiff > 0 ? '+' : '') + conDiff.toFixed(0)).padStart(8) + conFlag
    );

    if (Math.abs(depDiff) > 1) issues.push(`${shortStore}: 儲值差 ${depDiff.toFixed(0)}`);
    if (Math.abs(conDiff) > 1) issues.push(`${shortStore}: 消費差 ${conDiff.toFixed(0)}`);
  }

  console.log('-'.repeat(110));
  console.log(
    '合計'.padEnd(24) +
    totalSayDeposit.toFixed(0).padStart(10) +
    totalOdooDeposit.toFixed(0).padStart(10) +
    (totalOdooDeposit - totalSayDeposit).toFixed(0).padStart(8) +
    '    | ' +
    totalSayConsume.toFixed(0).padStart(10) +
    totalOdooConsume.toFixed(0).padStart(10) +
    (totalOdooConsume - totalSayConsume).toFixed(0).padStart(8)
  );

  // 也檢查 coupon 和 product_coupon
  let hasCoupon = false;
  for (const [store, odoo] of Object.entries(odooMap)) {
    if (odoo.coupon !== 0 || odoo.product !== 0) {
      if (!hasCoupon) { console.log('\n📌 優惠卷/商品卷:'); hasCoupon = true; }
      const s = store.replace('泡泡貓｜', '');
      console.log(`  ${s}: 優惠卷=${odoo.coupon}, 商品卷=${odoo.product}`);
    }
  }

  if (issues.length) {
    console.log('\n⚠️ 差異項目:');
    issues.forEach(i => console.log('  ' + i));
  } else {
    console.log('\n✅ 全部正確！');
  }

  p.end();
})();
