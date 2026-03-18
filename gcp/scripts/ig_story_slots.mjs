#!/usr/bin/env node
/**
 * ig_story_slots.mjs — 產生空位圖並發 IG Story
 * 
 * 用法：node ig_story_slots.mjs --store "竹北光明店" [--days 2]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getAuth } from '../lib/auth.js';
import { findAvailableSlotsAction } from '../api/core-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;

// ── Config ──
const META_TOKEN_PATH = path.join(HOME, '.openclaw/secrets/meta-token.txt');
const IG_USER_ID = '17841463367279845'; // @paopaomao_
const BOOKING_SITE_PUBLIC = path.join(HOME, '.openclaw/workspace/booking-site/public');
const BOOKING_SITE_URL = 'https://book.paopaomao.tw';

// ── Args ──
const args = process.argv.slice(2);
let storeName = '';
let preferUploadId = null;
let days = 2;
let previewOnly = true; // 預設只產圖不發布
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--store' && args[i+1]) storeName = args[++i];
  if (args[i] === '--days' && args[i+1]) days = parseInt(args[++i]) || 2;
  if (args[i] === '--publish') previewOnly = false;
  if (args[i] === '--prefer-upload' && args[i+1]) preferUploadId = args[++i];
}
if (!storeName) { console.error('Usage: node ig_story_slots.mjs --store "竹北光明店" [--publish]'); process.exit(1); }

if (!storeName.startsWith('泡泡貓')) storeName = `泡泡貓｜${storeName}`;

async function main() {
  // 1. DB: get saydou_id
  const shortName = storeName.replace(/泡泡貓[｜|]/, '').replace(/店$/, '');
  const pgResult = execSync(
    `/opt/homebrew/opt/postgresql@17/bin/psql -d paomao -t -A -c "SELECT store_name, saydou_id FROM stores WHERE store_name ILIKE '%${shortName.replace(/'/g, "''")}%' AND saydou_id IS NOT NULL LIMIT 1" -F '|'`,
    { encoding: 'utf8' }
  ).trim();
  
  if (!pgResult) { console.error(`❌ 找不到 ${storeName} 或沒有 saydou_id`); process.exit(1); }
  const [dbStoreName, sayId] = pgResult.split('|');
  storeName = dbStoreName || storeName; // 用 DB 的完整名稱
  console.log(`📍 ${storeName} (saydou_id: ${sayId})`);

  // Rate limit: 每店每天限一則
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const rateCheck = execSync(
    `/opt/homebrew/opt/postgresql@17/bin/psql -d paomao -t -A -c "SELECT COUNT(*) FROM story_stats WHERE store_name ILIKE '%${shortName.replace(/'/g, "''")}%' AND published_at::date = '${todayStr}'::date"`,
    { encoding: 'utf8' }
  ).trim();
  const isGongdao = storeName.includes('公道');
  if (parseInt(rateCheck) > 0 && !process.argv.includes('--force') && !isGongdao) {
    console.error(`⚠️ ${storeName} 今天已發過限動，每店每日限一則（加 --force 可強制）`);
    process.exit(1);
  }

  // 2. Query SayDou slots
  const today = new Date();
  const toYmd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const startDate = toYmd(today);
  const endDate = toYmd(new Date(today.getTime() + (days - 1) * 86400000));
  console.log(`📅 查詢空位: ${startDate} ~ ${endDate}`);

  const auth = await getAuth();
  const slotsData = await findAvailableSlotsAction(auth, {
    sayId, startDate, endDate, needPeople: 1, durationMin: 90
  });

  if (!slotsData?.status || !Array.isArray(slotsData.data)) {
    console.error('❌ SayDou API 無資料');
    process.exit(1);
  }

  const daysWithSlots = slotsData.data.filter(d => d?.times?.length > 0);
  if (daysWithSlots.length === 0) {
    console.log(`FULL:${shortName}`);
    process.exit(0);
  }

  const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
  const slotLines = daysWithSlots.map(d => {
    const date = d.date || '';
    const dayOfWeek = new Date(`${date}T00:00:00+08:00`).getDay();
    const shortDate = date.slice(5).replace('-', '/');
    const times = (d.times || []).slice(0, 6);
    return { label: `${shortDate} (${weekNames[dayOfWeek]})`, times };
  });

  console.log('空位：');
  slotLines.forEach(s => console.log(`  ${s.label}: ${s.times.join(', ')}`));

  // 3. 取該店上傳的素材當背景（使用者手選 > 未使用過 > 用最少次的）
  let storeUploadPath = '';
  let usedUploadId = null;
  try {
    let sql;
    if (preferUploadId) {
      sql = `SELECT id, file_url FROM story_uploads WHERE id = ${parseInt(preferUploadId)}`;
    } else {
      sql = `SELECT id, file_url FROM story_uploads WHERE store_name ILIKE '%${shortName.replace(/'/g, "''")}%' ORDER BY used_count ASC, created_at DESC LIMIT 1`;
    }
    const uploadResult = execSync(
      `/opt/homebrew/opt/postgresql@17/bin/psql -d paomao -t -A -c "${sql}"`,
      { encoding: 'utf8' }
    ).trim();
    if (uploadResult) {
      const [uploadId, fileUrl] = uploadResult.split('|');
      const fullPath = path.join(process.env.HOME, '泡泡貓/dashboard', fileUrl);
      if (fs.existsSync(fullPath)) {
        storeUploadPath = fullPath;
        usedUploadId = uploadId;
        // 查 used_count 判斷是新素材還是重複使用
        const countResult = execSync(
          `/opt/homebrew/opt/postgresql@17/bin/psql -d paomao -t -A -c "SELECT used_count FROM story_uploads WHERE id=${uploadId}"`,
          { encoding: 'utf8' }
        ).trim();
        const usedCount = parseInt(countResult) || 0;
        console.log(`🖼️ 使用素材: ${fileUrl} (已用${usedCount}次${usedCount === 0 ? '，首次使用✨' : ''})`);
      }
    }
  } catch {}
  if (!storeUploadPath) console.log('⚠️ 該店無上傳素材，使用品牌色背景');

  // Generate image (store upload bg + bubble overlay)
  const ts = Date.now();
  const imgPath = `/tmp/story-slots-${ts}.jpg`;
  const pyScript = generatePillowScript(shortName, slotLines, imgPath, storeUploadPath);
  const pyPath = `/tmp/story-slots-${ts}.py`;
  fs.writeFileSync(pyPath, pyScript);

  try {
    execSync(`/opt/homebrew/bin/python3 "${pyPath}"`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    console.error('Pillow 產圖失敗:', e.stderr || e.message);
    process.exit(1);
  }

  if (!fs.existsSync(imgPath)) { console.error('圖片未產生'); process.exit(1); }
  console.log(`🖼️ 圖片: ${imgPath} (${(fs.statSync(imgPath).size / 1024).toFixed(0)}KB)`);

  // 4. Public URL
  const filename = `story-slots-${ts}.jpg`;
  const webPath = path.join(BOOKING_SITE_PUBLIC, filename);
  fs.copyFileSync(imgPath, webPath);
  const imageUrl = `${BOOKING_SITE_URL}/${filename}`;
  console.log(`🌐 URL: ${imageUrl}`);
  console.log(`PREVIEW:${imageUrl}`);
  if (usedUploadId) console.log(`UPLOAD_ID:${usedUploadId}`);

  // Cleanup temp
  try { fs.unlinkSync(pyPath); } catch {}

  if (previewOnly) {
    console.log('📋 預覽模式 — 不發布到 IG。加 --publish 才會發布。');
    process.exit(0);
  }

  // 5. Post IG Story
  const token = fs.readFileSync(META_TOKEN_PATH, 'utf8').trim();

  const createRes = await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'STORIES', image_url: imageUrl, access_token: token })
  });
  const createData = await createRes.json();
  const containerId = createData.id;
  if (!containerId) { console.error('❌ Container 失敗:', createData); process.exit(1); }
  console.log(`📦 Container: ${containerId}`);

  // Wait
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await (await fetch(`https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${token}`)).json();
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') { console.error('❌ 處理失敗:', s); process.exit(1); }
  }

  // Publish
  const pubData = await (await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: token })
  })).json();

  if (pubData.id) {
    console.log(`✅ IG Story 發布成功！ID: ${pubData.id}`);
  } else {
    console.error('❌ 發布失敗:', pubData);
    process.exit(1);
  }

  // Cleanup
  setTimeout(() => {
    try { fs.unlinkSync(imgPath); } catch {}
    try { fs.unlinkSync(pyPath); } catch {}
    setTimeout(() => { try { fs.unlinkSync(webPath); } catch {} }, 120000);
  }, 5000);

  return { storyId: pubData.id, storeName: shortName };
}

function generatePillowScript(storeName, slotLines, outputPath, storeUploadPath) {
  const slotsJson = JSON.stringify(slotLines).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const bgPath = storeUploadPath ? storeUploadPath.replace(/'/g, "\\'") : '';
  return `
import json, random, os, subprocess, glob
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 1920

# 背景：優先用該店上傳的素材，沒有才 fallback 品牌色
store_bg = '${bgPath}'
bg = None
if store_bg and os.path.isfile(store_bg):
    bg = Image.open(store_bg).resize((W, H), Image.LANCZOS)
    img = bg.convert('RGBA')
else:
    img = Image.new('RGBA', (W, H), (24, 186, 225, 255))
    bg = None

# 右上角泡泡（毛玻璃）
bubble_r = 280
bubble_cx = W - bubble_r - 30
bubble_cy = 288 + bubble_r + 20

# Frosted glass: blur behind circle + white tint
blurred = bg.filter(ImageFilter.GaussianBlur(radius=25)) if bg else img.copy()
blurred_rgba = blurred.convert('RGBA')
mask = Image.new('L', (W, H), 0)
ImageDraw.Draw(mask).ellipse([bubble_cx-bubble_r, bubble_cy-bubble_r, bubble_cx+bubble_r, bubble_cy+bubble_r], fill=255)
frost = Image.composite(blurred_rgba, Image.new('RGBA', (W, H), (0,0,0,0)), mask)
# White tint
wt = Image.new('RGBA', (W, H), (0,0,0,0))
ImageDraw.Draw(wt).ellipse([bubble_cx-bubble_r, bubble_cy-bubble_r, bubble_cx+bubble_r, bubble_cy+bubble_r], fill=(255, 255, 255, 77))
frost = Image.alpha_composite(frost, wt)
# Border
bl = Image.new('RGBA', (W, H), (0,0,0,0))
ImageDraw.Draw(bl).ellipse([bubble_cx-bubble_r, bubble_cy-bubble_r, bubble_cx+bubble_r, bubble_cy+bubble_r], outline=(255,255,255,100), width=2)
frost = Image.alpha_composite(frost, bl)
img = Image.alpha_composite(img, frost)

# 小裝飾泡泡
for r, bx, by, a in [(45, 100, 380, 50), (30, 60, 580, 35), (20, 180, 1500, 40), (35, 80, 1350, 30)]:
    b = Image.new('RGBA', (W, H), (0,0,0,0))
    ImageDraw.Draw(b).ellipse([bx-r, by-r, bx+r, by+r], fill=(255,255,255,a))
    img = Image.alpha_composite(img, b)

img = img.convert('RGB')
draw = ImageDraw.Draw(img)

# Fonts
FP = '/System/Library/Fonts/STHeiti Medium.ttc'
FP_L = '/System/Library/Fonts/STHeiti Light.ttc'
font_title = ImageFont.truetype(FP, 48)
font_date = ImageFont.truetype(FP, 36)
font_time = ImageFont.truetype(FP, 30)
font_small = ImageFont.truetype(FP_L, 22)

C_MAIN = '#2A2A2A'
C_SUB = '#555555'
C_TIME = '#3E3A39'
BLUE = '#6B9BC3'

# 泡泡內文字
cx = bubble_cx
y = bubble_cy - bubble_r + 45

draw.text((cx, y), '${storeName}', font=font_title, fill=C_MAIN, anchor='mm')
y += 55
draw.text((cx, y), '- 近期空位 -', font=font_small, fill=C_SUB, anchor='mm')
y += 35
draw.line([(cx - 40, y), (cx + 40, y)], fill='#CCCCCC', width=1)
y += 30

slots = json.loads('${slotsJson}')
for day in slots:
    label = day['label']
    draw.text((cx, y), label, font=font_date, fill=C_MAIN, anchor='mm')
    bbox = draw.textbbox((cx, y), label, font=font_date, anchor='mm')
    draw.line([(bbox[0]+5, bbox[3]+2), (bbox[2]-5, bbox[3]+2)], fill=BLUE, width=2)
    y += 48
    times = day['times']
    for i in range(0, len(times), 2):
        row = times[i:i+2]
        draw.text((cx, y), ' · '.join(row), font=font_time, fill=C_TIME, anchor='mm')
        y += 38
    y += 15

# CTA
cta_y = bubble_cy + bubble_r - 60
f_cta = ImageFont.truetype(FP, 24)
f_url = ImageFont.truetype(FP_L, 16)
draw.text((cx, cta_y), '回覆「+1」立即預約 💬', font=f_cta, fill='#008BD5', anchor='mm')

img.save('${outputPath}', quality=92)
print('OK')
`;
}

main().catch(e => { console.error(e); process.exit(1); });
