# 泡泡貓分層AI路由 - 使用範例

## 🎯 路由邏輯

| 任務類型 | 路由方式 | 成本 | 範例 |
|---------|---------|------|------|
| **狀態查詢** | 規則→Flash | Level 1 | "系統狀態"、"檢查"、"顯示" |
| **編程開發** | 規則→Sonnet | Level 10 | "寫函數"、"修改code"、"API" |
| **架構設計** | 規則→Opus | Level 50 | "設計系統"、"架構規劃"、"策略" |
| **中等任務** | Sonnet判斷 | Level 15 | 需要分析的任務 |
| **複雜任務** | Opus規劃 | Level 60+ | 多步驟複雜項目 |

## 💡 使用方法

### 1. 直接使用Python版本
```bash
# 簡單查詢
python3 smart_hierarchical_router.py "系統狀態"
# → 規則分流到Flash，成本Level 1

# 編程任務  
python3 smart_hierarchical_router.py "寫一個計算加班費的Python函數"
# → 規則分流到Sonnet，成本Level 10

# 複雜規劃
python3 smart_hierarchical_router.py "設計完整的員工管理系統，包括打卡、薪資、請假"
# → Sonnet判斷→Opus架構師規劃，成本Level 60+
```

### 2. OpenClaw集成版本
```bash
# 智能路由對話
node openclaw_smart_router.js "你的任務"

# 查看詳細路由決策
node openclaw_smart_router.js "分析我們的AI成本" 2>&1 | grep -E "決策|理由|成本"
```

### 3. 與OpenClaw子任務整合
```bash
# 讓Opus規劃，然後spawn子任務執行
openclaw sessions spawn --task "用智能路由設計一個完整的CRM系統" --model default
```

## 🎯 省錢技巧

1. **簡化問題描述**：不要過度複雜化簡單任務
2. **明確任務類型**：用關鍵字觸發正確分流（"寫"、"檢查"、"設計"）
3. **分步驟執行**：大任務拆分，避免全程Opus
4. **善用規則分流**：80%任務可以規則直接分配

## 📊 成本對比

| 場景 | 傳統方式 | 智能分層路由 | 節省 |
|------|---------|-------------|------|
| 日常監控 | Opus Level 50 | Flash Level 1 | 98% |
| 編程任務 | Opus Level 50 | Sonnet Level 10 | 80% |
| 複雜規劃 | 盲目Opus | Opus+分派 | 20-40% |

**平均節省：70-85%**
