#!/usr/bin/env node
/**
 * Google Maps 商家權限管理
 * 為指定 email 批量設定泡泡貓門市的管理權限
 */

const fs = require('fs');
const path = require('path');

// 泡泡貓門市 Google Maps 資訊
const PAOMAO_STORES = [
  { name: "泡泡貓科技美容-新竹公道店", placeId: "ChIJXXXXXXXXXXXX", city: "新竹" },
  { name: "泡泡貓科技美容-台北信義店", placeId: "ChIJYYYYYYYYYYYY", city: "台北" },
  { name: "泡泡貓科技美容-高雄前鎮店", placeId: "ChIJZZZZZZZZZZZZ", city: "高雄" },
  { name: "泡泡貓科技美容-桃園中壢店", placeId: "ChIJAAAAAAAAAAAA", city: "桃園" },
  { name: "泡泡貓科技美容-台中西屯店", placeId: "ChIJBBBBBBBBBBBB", city: "台中" },
  // TODO: 補充完整的門市清單和正確的 Place ID
];

/**
 * 設定 Google Maps 商家權限
 * @param {string} email - 要授權的 email
 * @param {string} role - 權限角色: OWNER, MANAGER, SITE_MANAGER, COMMUNICATIONS_MANAGER
 */
async function setGoogleMapsPermissions(email, role = 'SITE_MANAGER') {
  console.log(`🗺️ 為 ${email} 設定 ${role} 權限...`);
  
  // 檢查 Google My Business API 憑證
  const credentialsPath = path.join(process.env.HOME, '.openclaw/secrets/google-mybusiness-credentials.json');
  if (!fs.existsSync(credentialsPath)) {
    console.error('❌ 找不到 Google My Business API 憑證');
    console.log('請先設定 Google My Business API 權限並下載憑證到:');
    console.log(credentialsPath);
    return false;
  }
  
  console.log('📋 準備設定以下門市權限:');
  PAOMAO_STORES.forEach(store => {
    console.log(`  - ${store.name} (${store.city})`);
  });
  
  console.log('\n⚠️ 注意: 這個腳本需要 Google My Business API 設定');
  console.log('由於 API 限制，建議手動操作或使用 Google Business Profile 網頁版');
  
  // 生成手動操作指南
  generateManualGuide(email, role);
  
  return true;
}

/**
 * 生成手動操作指南
 */
function generateManualGuide(email, role) {
  const roleNames = {
    'OWNER': '擁有者',
    'MANAGER': '管理者', 
    'SITE_MANAGER': '網站管理員',
    'COMMUNICATIONS_MANAGER': '通訊管理員'
  };
  
  const guide = `
# Google Maps 商家權限設定手冊

## 📧 授權對象
**Email:** ${email}
**權限級別:** ${roleNames[role]} (${role})

## 🏪 需要設定的門市

${PAOMAO_STORES.map((store, index) => `
### ${index + 1}. ${store.name}
**城市:** ${store.city}
**操作步驟:**
1. 前往 [Google Business Profile](https://business.google.com/)
2. 選擇「${store.name}」
3. 點擊左側選單「使用者」
4. 點擊「邀請使用者」
5. 輸入 email: \`${email}\`
6. 選擇角色：「${roleNames[role]}」
7. 點擊「邀請」

**權限說明 (${roleNames[role]}):**
✅ 編輯商家資訊
✅ 回覆評論
✅ 管理貼文
✅ 查看數據分析
❌ 刪除商家資訊
❌ 新增其他管理員

---`).join('')}

## 🔄 批量操作建議

由於 Google 沒有提供批量邀請 API，建議:

1. **開啟多個分頁** - 每個門市一個分頁
2. **使用相同步驟** - 複製貼上 email 地址
3. **確認權限級別** - 統一選擇「${roleNames[role]}」
4. **記錄完成狀態** - 勾選下方清單

## ✅ 完成清單

${PAOMAO_STORES.map(store => `- [ ] ${store.name}`).join('\n')}

---
*建議完成時間: 5-10 分鐘*
`;

  const outputPath = path.join(__dirname, '../docs/Google_Maps_權限設定指南.md');
  fs.writeFileSync(outputPath, guide);
  
  console.log(`\n📖 手動操作指南已生成: ${outputPath}`);
  console.log('\n🚀 建議操作流程:');
  console.log('1. 開啟 https://business.google.com/');
  console.log(`2. 逐一為 ${PAOMAO_STORES.length} 家門市邀請 ${email}`);
  console.log('3. 統一設定為「網站管理員」權限');
  console.log('4. 完成後對方會收到 email 邀請');
}

/**
 * 驗證 email 格式
 */
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// 命令列使用
if (require.main === module) {
  const [email, role] = process.argv.slice(2);
  
  if (!email) {
    console.log(`
🗺️ Google Maps 商家權限管理

使用方法:
  node google_maps_permissions.cjs <email> [role]

權限角色:
  SITE_MANAGER (預設)     - 網站管理員: 可編輯資訊、回覆評論
  COMMUNICATIONS_MANAGER  - 通訊管理員: 只能回覆評論和訊息  
  MANAGER                 - 管理者: 完整編輯權限
  OWNER                   - 擁有者: 完整控制權 (不建議)

範例:
  node google_maps_permissions.cjs mktpaopao88@gmail.com
  node google_maps_permissions.cjs mktpaopao88@gmail.com SITE_MANAGER
`);
    process.exit(0);
  }
  
  if (!validateEmail(email)) {
    console.error('❌ Email 格式不正確');
    process.exit(1);
  }
  
  const targetRole = role || 'SITE_MANAGER';
  const validRoles = ['OWNER', 'MANAGER', 'SITE_MANAGER', 'COMMUNICATIONS_MANAGER'];
  
  if (!validRoles.includes(targetRole)) {
    console.error(`❌ 無效的權限角色: ${targetRole}`);
    console.log(`有效選項: ${validRoles.join(', ')}`);
    process.exit(1);
  }
  
  setGoogleMapsPermissions(email, targetRole)
    .then(success => {
      if (success) {
        console.log('\n✅ 操作指南已生成完成');
        console.log(`請按照指南為 ${email} 設定權限`);
      } else {
        process.exit(1);
      }
    })
    .catch(e => {
      console.error('❌ 執行失敗:', e.message);
      process.exit(1);
    });
}

module.exports = { setGoogleMapsPermissions };