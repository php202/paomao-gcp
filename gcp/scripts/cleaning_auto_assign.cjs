#!/usr/bin/env node
/**
 * 每日環境整潔自動分派 v4.0 (API Wrapper)
 * Cron: 每天 12:00 (週一到週五)
 * 
 * Logic has been centralized into the dashboard server's
 * /api/cleaning/assign endpoint. This script now queries for
 * enabled stores and triggers the assignment via an API call
 * for each store, ensuring a single source of truth.
 */
const { Pool } = require('pg');

// Use dynamic import for ESM module node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function main() {
  console.log(`[cleaning] Auto-assign v4.0 starting`);
  const pool = new Pool({ connectionString: 'postgresql://localhost/paomao' });
  const dashboardUrl = 'http://localhost:3456'; // The main dashboard server is on 3456

  try {
    const { rows: features } = await pool.query(
      "SELECT store_name FROM store_features WHERE feature_key='cleaning_checklist' AND enabled=true"
    );

    if (!features.length) {
      console.log('[cleaning] No stores enabled for cleaning_checklist. Exiting.');
      return;
    }

    console.log(`[cleaning] Found ${features.length} enabled stores.`);

    for (const feature of features) {
      const store = feature.store_name;
      console.log(`\n[cleaning] Triggering assignment for: ${store}`);
      
      try {
        // This requires the server to be running and accessible.
        // It's assumed that the API call from localhost doesn't need auth,
        // which is typical for internal cron jobs.
        const response = await fetch(`${dashboardUrl}/api/cleaning/assign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // This is a placeholder for how you would pass a session if needed.
            // For this internal script, we rely on the server allowing localhost calls
            // without a full user session. This will fail if the endpoint strictly
            // requires an authenticated user session.
          },
          body: JSON.stringify({ store_name: store }),
          timeout: 60000, // 60 second timeout
        });

        const result = await response.json();

        if (response.ok) {
          console.log(`  → Success: Assigned ${result.count || 0} tasks for ${store}.`);
        } else if (response.status === 409) {
           console.log(`  → Skipped: ${store} was already assigned today.`);
        } else {
          console.error(`  → Error for ${store} (HTTP ${response.status}):`, result.error || 'Unknown error');
        }
      } catch (apiError) {
        console.error(`  → API call failed for ${store}:`, apiError.message);
      }
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
