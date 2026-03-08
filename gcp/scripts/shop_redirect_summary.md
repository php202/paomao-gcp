# shop.paopaomao.tw → https://paopaomao.tw/shop 重定向部署

## 📅 執行時間
**2026-03-07 00:00 (台北時間)** - 自動執行

## 🎯 功能
- `shop.paopaomao.tw` 會 301 重定向到 `https://paopaomao.tw/shop`
- 訪問任何 shop.paopaomao.tw 的路徑都會重定向到 Odoo 商店

## 🛠️ 技術架構

### 1. 重定向服務器
- **位置**: `/Users/paopaomao/paomao-gcp/gcp/scripts/shop_redirect_server.js`
- **端口**: 3870 (本機)
- **功能**: 純 Node.js HTTP 服務器，處理重定向
- **健康檢查**: `http://localhost:3870/health`

### 2. Cloudflare Tunnel
- **配置檔案**: `~/.cloudflared/config.yml`
- **新增規則**: `shop.paopaomao.tw → http://localhost:3870`
- **備份**: 部署時會自動備份舊配置

### 3. 系統服務
- **LaunchD**: `com.paopaomao.shop-redirect.plist`
- **自動啟動**: 開機時不啟動，部署時手動啟動
- **日誌位置**: `~/Library/Logs/shop-redirect.log`

### 4. OpenClaw 自動化
- **Cron ID**: `c05e2cde-eee3-49fd-8198-22f279a3fd30`
- **執行頻率**: 一次性任務 (3/7 00:00)
- **通知**: 成功或失敗都會發送 Telegram 通知

## 📋 部署流程

1. **啟動重定向服務** (port 3870)
2. **備份現有 cloudflared 配置**
3. **更新 cloudflared 配置** (新增 shop.paopaomao.tw)
4. **重啟 cloudflared 服務**
5. **驗證部署結果**
6. **發送成功/失敗通知**

## ✅ 測試結果 (2026-03-05)

所有測試都通過：
- ✅ 重定向服務器功能正常 (HTTP 301)
- ✅ 目標 URL 正確 (`https://paopaomao.tw/shop`)
- ✅ Cloudflared 運行正常
- ✅ Cron 任務已設置
- ✅ 所有權限設置正確

## 🔧 手動操作

### 提前測試部署
```bash
bash /Users/paopaomao/paomao-gcp/gcp/scripts/deploy_shop_redirect.sh
```

### 服務管理
```bash
# 啟動服務
launchctl load ~/Library/LaunchAgents/com.paopaomao.shop-redirect.plist

# 停止服務  
launchctl unload ~/Library/LaunchAgents/com.paopaomao.shop-redirect.plist

# 檢查狀態
curl http://localhost:3870/health
```

### 檢查 Cron 任務
```bash
# 查看任務狀態
openclaw cron list | grep shop-redirect

# 取消任務 (如果需要)
openclaw cron rm c05e2cde-eee3-49fd-8198-22f279a3fd30
```

## 🛡️ 故障恢復

- **配置備份**: 部署時會自動備份 cloudflared 配置
- **回滾指令**: `cp ~/.cloudflared/config.yml.backup.* ~/.cloudflared/config.yml`
- **重啟服務**: `launchctl kickstart -k gui/$(id -u)/com.paopaomao.cloudflared`

## 📊 驗證方法

部署後可用以下方式驗證：

```bash
# 檢查 HTTP 狀態碼
curl -I https://shop.paopaomao.tw

# 檢查重定向目標  
curl -I https://shop.paopaomao.tw 2>&1 | grep -i location

# 本機服務檢查
curl http://localhost:3870/health
```

## ⚠️ 注意事項

1. **DNS 傳播**: 部署後可能需要幾分鐘等待 DNS 全球傳播
2. **快取**: 瀏覽器可能會快取重定向，測試時使用無痕模式
3. **通知**: 部署成功或失敗都會自動發送 Telegram 通知給 Robby

---

**狀態**: ✅ 準備就緒，等待自動執行  
**下次執行**: 2026-03-07 00:00 (Asia/Taipei)  
**預計完成時間**: 2026-03-07 00:02