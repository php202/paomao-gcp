# 問題集自動分配系統使用說明

## 🎯 **功能說明**

自動分配系統會根據關鍵字匹配，將未分配問題自動分派給對應負責人。

### **分配規則：**
- **小羅**：刪單、退費、儲值金、請款、匯款、會計、發票、稅務
- **Yen**：維修、儀器、故障、電路、電線、送修
- **圓圓**：行銷、廣告、社群、品牌、IG、FB、巡店
- **慈慈**：教育、訓練、SOP、課程、內容、考核
- **Miya**：行政、門市、產品、備品、配送、預約系統、神美
- **Rick**：人事、排班、策略、加盟、合約
- **家盈**：對日帳、盤點、庫存、進銷存

### **高難度問題自動留空：**
緊急、嚴重、重大、危機、加盟主、股東、法律、糾紛、系統崩潰等

## 🚀 **使用方式**

### **1. 手動執行**

```bash
cd ~/paomao-gcp/gcp

# 處理今天的問題（預設）
node scripts/issues_auto_assign_integration.cjs

# 乾跑模式 - 只分析不實際分配
node scripts/issues_auto_assign_integration.cjs --dry-run

# 處理特定時間範圍
node scripts/issues_auto_assign_integration.cjs --yesterday  # 昨天
node scripts/issues_auto_assign_integration.cjs --week      # 最近7天
node scripts/issues_auto_assign_integration.cjs --all       # 最近30天（慎用！）

# 檢查特定問題的分配建議
node scripts/issues_auto_assign_integration.cjs --check 2500
```

### **2. 自動定期執行**

```bash
# 啟動定期分配（每2小時執行，只處理今天的問題）
launchctl load ~/Library/LaunchAgents/com.paopaomao.issues-auto-assign.plist

# 停止定期分配
launchctl unload ~/Library/LaunchAgents/com.paopaomao.issues-auto-assign.plist

# 檢查執行狀態
launchctl list | grep issues-auto-assign

# 查看執行日誌
tail -f /tmp/issues-auto-assign.log
```

## 📊 **測試和分析工具**

```bash
cd ~/paomao-gcp/gcp

# 分析現有分配狀況
node scripts/test_issue_assignment.cjs

# 測試關鍵字匹配效果
node scripts/test_issue_assignment.cjs --keywords

# 全面分析（包含關鍵字測試）
node scripts/test_issue_assignment.cjs --test-keywords
```

## ⚠️ **重要注意事項**

### **1. 時間範圍控制**
- **預設只處理今天的問題**，避免重新分配歷史案件
- 使用 `--week` 或 `--all` 參數時需特別謹慎
- 定期執行只會處理當天新增的未分配問題

### **2. 安全機制**
- 高難度問題自動留空，需人工分配
- 信心門檻設定為 3 分以上才自動分配
- 乾跑模式可預覽分配結果不實際執行

### **3. Telegram 通知**
- 成功分配後會發送通知到辦公室群組
- 包含分配明細和需人工處理的案件數量

## 🔧 **自定義設定**

### **修改分配規則：**
編輯 `lib/issue-auto-assign-optimized.cjs` 中的 `OPTIMIZED_ASSIGNMENT_RULES`

### **調整高難度關鍵字：**
編輯 `HIGH_COMPLEXITY_KEYWORDS` 陣列

### **修改信心門檻：**
在 `optimizedAutoAssign` 函數中調整 `topScore >= 3` 的數值

### **調整執行頻率：**
修改 `~/Library/LaunchAgents/com.paopaomao.issues-auto-assign.plist` 中的 `StartInterval`

## 📈 **效果監控**

- 準確度：目前測試 8/9 正確 (89%)
- 自動分配率：約 60-70%（其餘需人工分配）
- 執行日誌：`/tmp/issues-auto-assign.log`

## 🆘 **常見問題**

**Q: 如何暫停自動分配？**
```bash
launchctl unload ~/Library/LaunchAgents/com.paopaomao.issues-auto-assign.plist
```

**Q: 如何查看分配歷史？**
```bash
grep "分配給" /tmp/issues-auto-assign.log
```

**Q: 如何手動測試不影響實際分配？**
```bash
node scripts/issues_auto_assign_integration.cjs --dry-run
```

**Q: 分配錯誤怎麼辦？**
在 Dashboard 中手動重新分配即可，系統不會覆蓋已分配的問題。