#!/usr/bin/env node
/**
 * 每日環境整潔自動分派 v5.0 (Cron-safe API)
 * Cron: 每天 16:00 (週一到週五)
 * 
 * Calls the dashboard's /api/cleaning/cron-assign endpoint (localhost only, no auth).
 */
const { Pool } = require('pg');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function main() {
  console.log(`[cleaning] Auto-assign v5.0 starting`);
  const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });
  const dashboardUrl = 'http://localhost:3000'; // Dashboard server on port 3000

  try {
    const { rows: features } = await pool.query(
      "SELECT store_name FROM store_features WHERE feature_key='cleaning_checklist' AND enabled=true"
    );

    if (!features.length) {
      console.log('[cleaning] No stores enabled for cleaning_checklist. Exiting.');
      return;
    }

    console.log(`[cleaning] Found ${features.length} enabled stores.`);
    const results = { success: [], skipped: [], failed: [] };

    for (const feature of features) {
      const store = feature.store_name;
      console.log(`\n[cleaning] Triggering assignment for: ${store}`);
      
      try {
        const response = await fetch(`${dashboardUrl}/api/cleaning/cron-assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store_name: store }),
          timeout: 60000,
        });

        const result = await response.json();

        if (response.ok) {
          console.log(`  → Success: Assigned ${result.count || 0} tasks for ${store}.`);
          results.success.push({ store, count: result.count || 0 });
        } else if (response.status === 409) {
          console.log(`  → Skipped: ${store} was already assigned today.`);
          results.skipped.push(store);
        } else {
          console.error(`  → Error for ${store} (HTTP ${response.status}):`, result.error || 'Unknown error');
          results.failed.push({ store, error: result.error || `HTTP ${response.status}` });
        }
      } catch (apiError) {
        console.error(`  → API call failed for ${store}:`, apiError.message);
        results.failed.push({ store, error: apiError.message });
      }
    }

    // Summary
    console.log('\n[cleaning] === Summary ===');
    console.log(`  Success: ${results.success.length}, Skipped: ${results.skipped.length}, Failed: ${results.failed.length}`);
    if (results.failed.length) {
      console.log('  Failed stores:', results.failed.map(f => `${f.store}: ${f.error}`).join('; '));
    }
  } catch (dbError) {
    console.error('[cleaning] Database query failed:', dbError);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('\n[cleaning] Auto-assign run finished.');
  }
}

main().catch(e => {
  console.error('[cleaning] Unhandled error:', e);
  process.exit(1);
});
