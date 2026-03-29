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

    // ── Get workers from SayDou → fallback to checkin_records ──
    let workers = [];
    const { rows: storeInfo } = await pool.query(
      "SELECT saydou_id FROM stores WHERE store_name=$1 AND saydou_id IS NOT NULL AND saydou_id != '' LIMIT 1", [store]);
    const saydouId = storeInfo[0]?.saydou_id;

    if (saydouId) {
      // Pull distinct employee_codes from today's transaction remarks
      const { rows: remarkRows } = await pool.query(`
        SELECT DISTINCT LOWER(TRIM(SPLIT_PART(remark, ' ', 1))) AS code
        FROM saydou_transactions
        WHERE storid = $1::int AND rectim::date = $2::date
          AND remark IS NOT NULL AND remark != ''
      `, [saydouId, today]);

      // Extract employee code: strip parentheses, Chinese chars, and extra text after the code
      const codes = remarkRows.map(r => {
        const match = r.code.match(/^([a-z]{1,5}\d{1,4})/i);
        return match ? match[1].toLowerCase() : null;
      }).filter(Boolean);
      const uniqueCodes = [...new Set(codes)];

      if (uniqueCodes.length) {
        const { rows: matched } = await pool.query(`
          SELECT DISTINCT ON (LOWER(employee_code)) id, name, employee_code, title
          FROM employees
          WHERE store_name = $1 AND is_active = true
            AND LOWER(employee_code) = ANY($2)
            AND title NOT LIKE '%離職%'
            AND title NOT IN ('店長','加盟主','管理者')
          ORDER BY LOWER(employee_code), id
        `, [store, uniqueCodes]);
        workers = matched;
      }
    }

    // Fallback: checkin_records
    if (!workers.length) {
      console.log(`  → SayDou lookup failed, trying checkin_records fallback`);
      const { rows: checkedIn } = await pool.query(
        `SELECT DISTINCT e.id, e.name, e.employee_code, e.title
         FROM checkin_records cr JOIN employees e ON cr.line_user_id = e.line_user_id
         WHERE cr.store_name=$1 AND cr.checked_at::date=$2::date AND cr.check_type='in'
           AND e.store_name=$1 AND e.is_active=true
           AND e.title NOT LIKE '%離職%' AND e.title NOT IN ('店長','加盟主','管理者')
         ORDER BY e.id`, [store, today]);
      workers = checkedIn;
    }

    if (!workers.length) { console.log('  → No workers found (SayDou + checkin fallback both empty)'); continue; }
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

    const dailyShared = allZones.filter(z => 'ABCDFGH'.includes(z.zone_code) && isDue(z)); // A-H except E
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

    // ═══ 0. E/F/G 區: 固定雙人負責（優先分派）；人數不足時單人 ═══
    // 人數 ≤ 2 時不分派 D 和 H
    const skipZones = empCount <= 2 ? new Set(['D', 'H']) : new Set();

    for (const dualCode of ['E', 'F', 'G']) {
      const dualZone = allZones.find(z => z.zone_code === dualCode && isDue(z));
      if (!dualZone) continue;
      if (empCount >= 2) {
        const candidates = [...empIds].sort((a, b) => (histMap[`${a}_${dualCode}`] || 0) - (histMap[`${b}_${dualCode}`] || 0));
        [candidates[0], candidates[1]].forEach(eid => {
          assignments.push({ eid, zone_code: dualCode, zone_name: dualZone.zone_name, is_primary: true, assigned_items: dualZone.checklist_items || [] });
          empZoneCount[eid]++;
        });
      } else {
        assignments.push({ eid: empIds[0], zone_code: dualCode, zone_name: dualZone.zone_name, is_primary: true, assigned_items: dualZone.checklist_items || [] });
        empZoneCount[empIds[0]]++;
      }
    }

    // ═══ 1. A-D, H: 平均分派（E/F/G 已單獨處理；D/H 在人數≤2時跳過） ═══
    const dailySharedFiltered = dailyShared.filter(z => !['E', 'F', 'G'].includes(z.zone_code) && !skipZones.has(z.zone_code));
    if (empCount >= dailySharedFiltered.length) {
      const used = new Set();
      for (const zone of dailySharedFiltered) {
        let best = null, bestCnt = Infinity;
        for (const eid of empIds) {
          if (used.has(eid)) continue;
          const cnt = histMap[`${eid}_${zone.zone_code}`] || 0;
          if (cnt < bestCnt) { bestCnt = cnt; best = eid; }
        }
        if (best) { used.add(best); assignments.push({ eid: best, zone_code: zone.zone_code, zone_name: zone.zone_name, is_primary: true, assigned_items: zone.checklist_items || [] }); empZoneCount[best]++; }
      }
    } else {
      for (const zone of dailySharedFiltered) {
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
      const dow = now.getDay(); // 0=Sun 1=Mon ... 6=Sat
      const filteredItems = allItems.filter(item => {
        if (item.includes('椅輪')) return [1, 3, 5].includes(dow);        // Mon/Wed/Fri
        if (item.includes('台車輪子')) return [2, 6].includes(dow);       // Tue/Sat
        if (item.includes('台車')) return [2, 4, 6].includes(dow);        // Tue/Thu/Sat
        if (item.includes('燈座')) return [1, 3, 5].includes(dow);        // Mon/Wed/Fri
        if (item.includes('美容床')) return [2, 4, 6].includes(dow);      // Tue/Thu/Sat
        if (item.includes('補光燈')) return [4, 0].includes(dow);         // Thu/Sun
        return true;                                                       // always
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
    const insertedIds = [];
    for (const a of assignments) {
      const items = Array.isArray(a.assigned_items) ? JSON.stringify(a.assigned_items) : null;
      const result = await pool.query(
        `INSERT INTO cleaning_assignments (date, store_name, employee_id, employee_name, zone_code, zone_name, is_primary, checklist_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [today, store, a.eid, empMap[a.eid], a.zone_code, a.zone_name, a.is_primary, items]);
      if (result.rows[0]) insertedIds.push({ id: result.rows[0].id, eid: a.eid });
    }

    // ─── Assign peer reviewers (round-robin, evenly distributed) ───
    const byEmployee = {};
    for (const a of insertedIds) {
      if (!byEmployee[a.eid]) byEmployee[a.eid] = [];
      byEmployee[a.eid].push(a.id);
    }
    const allEmpIds = Object.keys(byEmployee).map(Number);
    if (allEmpIds.length > 1) {
      for (const empId of allEmpIds) {
        const zones = byEmployee[empId];
        const otherEmps = allEmpIds.filter(e => e !== empId);
        for (let i = 0; i < zones.length; i++) {
          const reviewer = otherEmps[i % otherEmps.length];
          await pool.query('UPDATE cleaning_assignments SET assigned_reviewer_id=$1 WHERE id=$2', [reviewer, zones[i]]);
        }
      }
    }

    console.log(`  → Assigned ${assignments.length} total (A-H: ${dailyShared.length}, I: ${zoneI ? empCount : 0}, periodic: ${periodic.reduce((s, z) => s + (z.checklist_items||[]).length, 0)} items)`);
  }

  await pool.end();
  console.log('\n[cleaning] Done');
}

main().catch(e => { console.error(e); process.exit(1); });
