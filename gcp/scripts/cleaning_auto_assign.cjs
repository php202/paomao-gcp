#!/usr/bin/env node
/**
 * 每日環境整潔自動分派 v3.0
 * Cron: 每天 16:00
 * 
 * 分派規則：
 * - A-H: 平均分派給當日施作員工
 * - I: 每人每天必做（個人儀器清潔）
 * - J-N: 週期到期時，細項平均分配給員工
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  return hash;
}

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const now = new Date();
  const todayDow = now.getDay(), todayDateNum = now.getDate(), todayMonth = now.getMonth() + 1;
  console.log(`[cleaning] Auto-assign v3.0 for ${today}`);

  const { rows: features } = await pool.query(
    "SELECT store_name FROM store_features WHERE feature_key='cleaning_checklist' AND enabled=true");
  if (!features.length) { console.log('[cleaning] No stores enabled'); return; }

  for (const f of features) {
    const store = f.store_name;
    console.log(`\n[cleaning] Processing: ${store}`);

    const { rows: existing } = await pool.query(
      'SELECT id FROM cleaning_assignments WHERE store_name=$1 AND date=$2 LIMIT 1', [store, today]);
    if (existing.length) { console.log('  → Already assigned, skip'); continue; }

    // ── Get workers from SayDou ──
    const { rows: storeInfo } = await pool.query(
      "SELECT saydou_id FROM stores WHERE store_name=$1 AND saydou_id IS NOT NULL AND saydou_id != '' LIMIT 1", [store]);
    const saydouId = storeInfo[0]?.saydou_id;
    if (!saydouId) { console.log('  → No saydou_id, skip'); continue; }

    // Pull distinct employee_codes from today's transaction remarks
    const { rows: remarkRows } = await pool.query(`
      SELECT DISTINCT LOWER(TRIM(SPLIT_PART(remark, ' ', 1))) AS code
      FROM saydou_transactions
      WHERE storid = $1::int AND rectim::date = $2::date
        AND remark IS NOT NULL AND remark != ''
    `, [saydouId, today]);

    // Filter valid employee_code patterns (letters + digits)
    const codes = remarkRows.map(r => r.code).filter(c => /^[a-z]{1,5}\d{1,4}$/i.test(c));
    if (!codes.length) { console.log('  → No valid employee codes in remarks'); continue; }

    // Match to employees table
    const { rows: workers } = await pool.query(`
      SELECT DISTINCT ON (LOWER(employee_code)) id, name, employee_code, title
      FROM employees
      WHERE store_name = $1 AND is_active = true
        AND LOWER(employee_code) = ANY($2)
        AND title NOT LIKE '%離職%'
        AND title NOT IN ('店長','加盟主','管理者')
      ORDER BY LOWER(employee_code), id
    `, [store, codes]);
    if (!workers.length) { console.log(`  → No employees matched codes: ${codes.join(', ')}`); continue; }
    console.log(`  → ${workers.length} workers: ${workers.map(w => `${w.name}(${w.employee_code})`).join(', ')}`);

    const empIds = workers.map(w => w.id);
    const empMap = Object.fromEntries(workers.map(w => [w.id, w.name]));
    const empCount = workers.length;

    // ── Load zones ──
    const { rows: allZones } = await pool.query(
      `SELECT zone_code, zone_name, frequency, priority, checklist_items FROM cleaning_zones
       WHERE is_active=true AND (store_name IS NULL OR store_name='' OR store_name=$1) ORDER BY sort_order`, [store]);
    const { rows: completions } = await pool.query(
      `SELECT zone_code, last_completed FROM cleaning_zone_completions WHERE store_name=$1`, [store]);
    const compMap = Object.fromEntries(completions.map(c => [c.zone_code, c.last_completed]));

    function isDue(z) {
      const freq = z.frequency || 'daily';
      if (freq === 'daily') return true;
      const last = compMap[z.zone_code] ? new Date(compMap[z.zone_code]) : null;
      if (freq === '3_days') return !last || (now - last) >= 3 * 86400000;
      if (freq === 'weekly') return todayDow === 1;
      if (freq === 'monthly') return todayDateNum === 1;
      if (freq === 'semi_annual') return (todayMonth === 1 || todayMonth === 7) && todayDateNum === 1;
      return true;
    }

    const dailyShared = allZones.filter(z => 'ABCDEFGH'.includes(z.zone_code) && isDue(z));
    const zoneI = allZones.find(z => z.zone_code === 'I' && isDue(z));
    const periodic = allZones.filter(z => 'JKLMN'.includes(z.zone_code) && isDue(z));

    // History for fair rotation
    const { rows: history } = await pool.query(
      `SELECT employee_id, zone_code, COUNT(*) as cnt FROM cleaning_assignments
       WHERE store_name=$1 AND date >= (CURRENT_DATE - 30) GROUP BY employee_id, zone_code`, [store]);
    const histMap = {};
    history.forEach(h => { histMap[`${h.employee_id}_${h.zone_code}`] = parseInt(h.cnt); });

    const assignments = [];
    const empZoneCount = Object.fromEntries(empIds.map(id => [id, 0]));

    // ═══ 0. E 區: 固定雙人負責（優先分派） ═══
    const zoneE = allZones.find(z => z.zone_code === 'E' && isDue(z));
    if (zoneE && empCount >= 2) {
      const candidates = [...empIds].sort((a, b) => (histMap[`${a}_E`] || 0) - (histMap[`${b}_E`] || 0));
      [candidates[0], candidates[1]].forEach(eid => {
        assignments.push({ eid, zone_code: 'E', zone_name: zoneE.zone_name, is_primary: true, assigned_items: zoneE.checklist_items || [] });
        empZoneCount[eid]++;
      });
    } else if (zoneE) {
      assignments.push({ eid: empIds[0], zone_code: 'E', zone_name: zoneE.zone_name, is_primary: true, assigned_items: zoneE.checklist_items || [] });
      empZoneCount[empIds[0]]++;
    }

    // ═══ 1. A-D, F-H: 平均分派 ═══
    const dailySharedNoE = dailyShared.filter(z => z.zone_code !== 'E');
    if (empCount >= dailySharedNoE.length) {
      const used = new Set();
      for (const zone of dailySharedNoE) {
        let best = null, bestCnt = Infinity;
        for (const eid of empIds) {
          if (used.has(eid)) continue;
          const cnt = histMap[`${eid}_${zone.zone_code}`] || 0;
          if (cnt < bestCnt) { bestCnt = cnt; best = eid; }
        }
        if (best) { used.add(best); assignments.push({ eid: best, zone_code: zone.zone_code, zone_name: zone.zone_name, is_primary: true, assigned_items: zone.checklist_items || [] }); empZoneCount[best]++; }
      }
    } else {
      for (const zone of dailySharedNoE) {
        let best = null, bestZones = Infinity;
        for (const eid of empIds) { if (empZoneCount[eid] < bestZones) { bestZones = empZoneCount[eid]; best = eid; } }
        if (best) {
          assignments.push({ eid: best, zone_code: zone.zone_code, zone_name: zone.zone_name, is_primary: empZoneCount[best] === 0, assigned_items: zone.checklist_items || [] });
          empZoneCount[best]++;
        }
      }
    }

    // ═══ 2. I: 每人必做，依星期過濾細項 ═══
    if (zoneI) {
      const allItems = zoneI.checklist_items || [];
      const dow = now.getDay();
      const filteredItems = allItems.filter(item => {
        if (item.includes('椅輪')) return [1, 3, 5].includes(dow);
        if (item.includes('台車')) return [2, 4, 6].includes(dow);
        return true;
      });
      for (const eid of empIds) {
        assignments.push({ eid, zone_code: 'I', zone_name: zoneI.zone_name, is_primary: true, assigned_items: filteredItems });
      }
    }

    // ═══ 3. J-N: 細項級分配 ═══
    const allPeriodicItems = [];
    for (const zone of periodic) {
      (zone.checklist_items || []).forEach(item => { allPeriodicItems.push({ zone_code: zone.zone_code, zone_name: zone.zone_name, item }); });
    }
    if (allPeriodicItems.length) {
      const empByHist = [...empIds].sort((a, b) => {
        const aT = periodic.reduce((s, z) => s + (histMap[`${a}_${z.zone_code}`] || 0), 0);
        const bT = periodic.reduce((s, z) => s + (histMap[`${b}_${z.zone_code}`] || 0), 0);
        return aT - bT;
      });
      const perPerson = Object.fromEntries(empIds.map(id => [id, []]));
      allPeriodicItems.forEach((entry, idx) => { perPerson[empByHist[idx % empCount]].push(entry); });
      for (const eid of empIds) {
        const byZone = {};
        perPerson[eid].forEach(e => { if (!byZone[e.zone_code]) byZone[e.zone_code] = { zone_name: e.zone_name, items: [] }; byZone[e.zone_code].items.push(e.item); });
        for (const [zc, data] of Object.entries(byZone)) {
          assignments.push({ eid, zone_code: zc, zone_name: data.zone_name, is_primary: true, assigned_items: data.items });
        }
      }
    }

    // ─── Insert ───
    for (const a of assignments) {
      const items = Array.isArray(a.assigned_items) ? JSON.stringify(a.assigned_items) : null;
      await pool.query(
        `INSERT INTO cleaning_assignments (date, store_name, employee_id, employee_name, zone_code, zone_name, is_primary, checklist_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [today, store, a.eid, empMap[a.eid], a.zone_code, a.zone_name, a.is_primary, items]);
    }
    console.log(`  → Assigned ${assignments.length} total (A-H: ${dailyShared.length}, I: ${zoneI ? empCount : 0}, periodic: ${periodic.reduce((s, z) => s + (z.checklist_items||[]).length, 0)} items)`);
  }

  await pool.end();
  console.log('\n[cleaning] Done');
}

main().catch(e => { console.error(e); process.exit(1); });
