#!/usr/bin/env node
/**
 * story_save_thumbnails.cjs
 * 抓取目前活著的 IG Story 的縮圖，存本機 + 更新 DB
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ database: 'paomao' });
const META_TOKEN = fs.readFileSync(path.join(process.env.HOME, '.openclaw/secrets/meta-token.txt'), 'utf8').trim();
const IG_USER_ID = '17841463367279845';
const THUMB_DIR = path.join(process.env.HOME, '泡泡貓/dashboard/uploads/story-thumbnails');

async function main() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });

  // 1. 取得目前活躍的 Stories
  const storiesRes = await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/stories?fields=id,timestamp,media_type,media_url,thumbnail_url&access_token=${META_TOKEN}`);
  const storiesData = await storiesRes.json();
  const stories = storiesData.data || [];
  console.log(`[story-thumb] Active stories: ${stories.length}`);

  for (const s of stories) {
    const thumbPath = path.join(THUMB_DIR, `${s.id}.jpg`);
    if (fs.existsSync(thumbPath)) {
      console.log(`  ⏭️ ${s.id} already saved`);
      continue;
    }

    const thumbUrl = s.thumbnail_url || s.media_url;
    if (!thumbUrl) { console.log(`  ❌ ${s.id} no thumbnail`); continue; }

    try {
      const res = await fetch(thumbUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(thumbPath, buf);
      console.log(`  ✅ ${s.id} saved (${buf.length} bytes)`);

      // Upsert to DB
      const dbThumbUrl = `/uploads/story-thumbnails/${s.id}.jpg`;
      const published = s.timestamp;
      
      // 先嘗試更新
      const { rowCount } = await pool.query(
        "UPDATE story_stats SET thumbnail_url=$1 WHERE ig_media_id=$2",
        [dbThumbUrl, s.id]
      );
      
      if (rowCount === 0) {
        // 新的 story，還沒在 DB — 先不 insert，等 insights cron 拉數據
        console.log(`  📝 ${s.id} not in DB yet (will be added by insights cron)`);
      }
    } catch (e) {
      console.error(`  ❌ ${s.id} error: ${e.message}`);
    }
  }

  await pool.end();
  console.log('[story-thumb] Done');
}

main().catch(e => { console.error(e); process.exit(1); });
