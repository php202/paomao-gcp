# 續約品質控管 Agent — 開發規劃

> 核心目標：透過自動化考核（巡店、技術、評價、回訓）決定加盟商續約資格

---

## 一、現有資源盤點

### 已建好的 DB 表
| 表名 | 狀態 | 內容 |
|------|------|------|
| `store_contracts` | ✅ 有資料 | 合約到期日 `expire_date`、合約類型、乙方資訊 |
| `inspection_categories` | ✅ 有資料 | 6 大巡店分類 |
| `inspection_items` | ✅ 72 項 | 具體檢核項目 + 扣分 |
| `inspection_records` | ✅ 結構完成 | 巡店記錄 + 評分 + 等級 |
| `inspection_details` | ✅ 結構完成 | 逐項通過/不通過 |
| `inspection_schedules` | ✅ 結構完成 | 季度巡店排程 |
| `improvement_photos` | ✅ 結構完成 | 改善照片回傳 |
| `stores` | ✅ 41 間 | 29 加盟 + 7 直營 + 3 特許 + 2 其他 |

### 已有 Google Map URL
- 36/41 間店已填 `google_map_url` → 可直接用 Google Places API 抓評價

### 缺少的
- `renewal_assessments` 表（三階段評估結果）
- `renewal_tasks` 表（改善任務派發 + 閉環追蹤）
- `store_google_reviews` 表（評價歷史快照）
- Google Places API key（或用現有 GCP service account）

---

## 二、數據串接設計

### 2.1 巡店評分（已有）
```
inspection_records → final_score, grade
inspection_details → 逐項扣分明細
```
- 每季巡店一次，資料已在 DB
- Agent 直接 `SELECT` 即可

### 2.2 Google 評價抓取（新建）

```sql
CREATE TABLE store_google_reviews (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  store_name TEXT,
  place_id TEXT,                    -- Google Places ID
  rating NUMERIC(2,1),             -- 當下總評分 (e.g. 4.3)
  review_count INT,                -- 評論數
  recent_1star_count INT DEFAULT 0,-- 近 90 天 1 星數
  recent_avg NUMERIC(2,1),         -- 近 90 天平均分
  snapshot_date DATE,
  raw_reviews JSONB,               -- 最新 5 則評論原文（含 AI 分析標籤）
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**抓取流程：**
1. `stores.google_map_url` → 解析出 `place_id`
2. Google Places API `details` → 評分 + 評論
3. 每月 1 號 cron 自動快照，存入 `store_google_reviews`
4. 1 星評論自動標記關鍵字（衛生、態度、推銷...）

### 2.3 技術考核（串 Odoo eLearning）
- 現有 Odoo 課程完成度 API（134 學員、10 課程）
- 加盟店店長 + 員工的必修課程完成率
- 完成率 < 60% → 列入改善項目

### 2.4 回訓記錄（新建欄位）
```sql
ALTER TABLE inspection_details ADD COLUMN retraining_required BOOLEAN DEFAULT FALSE;
ALTER TABLE inspection_details ADD COLUMN retraining_scheduled_at TIMESTAMPTZ;
ALTER TABLE inspection_details ADD COLUMN retraining_completed_at TIMESTAMPTZ;
ALTER TABLE inspection_details ADD COLUMN retraining_result TEXT; -- pass/fail
```

---

## 三、三階段自動預警系統

以 `store_contracts.expire_date` 為基準，倒推觸發：

### 新建表

```sql
CREATE TABLE renewal_assessments (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  contract_id INT REFERENCES store_contracts(id),
  store_name TEXT NOT NULL,
  expire_date DATE NOT NULL,

  -- 階段
  phase TEXT NOT NULL CHECK (phase IN ('diagnosis', 'recheck', 'verdict')),
  phase_trigger_date DATE NOT NULL,  -- 預計觸發日
  phase_executed_at TIMESTAMPTZ,     -- 實際執行時間

  -- 綜合評分
  inspection_score NUMERIC(5,2),     -- 巡店分（最近一次）
  google_rating NUMERIC(2,1),        -- Google 評價
  google_1star_count INT,            -- 近 90 天 1 星數
  course_completion_rate NUMERIC(5,2), -- 課程完成率 %
  improvement_close_rate NUMERIC(5,2), -- 改善結案率 %
  composite_score NUMERIC(5,2),      -- 加權綜合分

  -- 結論
  risk_level TEXT CHECK (risk_level IN ('green', 'yellow', 'orange', 'red')),
  recommendation TEXT,  -- auto_renew / conditional / review / terminate
  auto_tasks JSONB,     -- 自動派發的任務列表
  reviewer_notes TEXT,   -- 人工審核備註
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_renewal_phase ON renewal_assessments(store_id, phase);
CREATE INDEX idx_renewal_trigger ON renewal_assessments(phase_trigger_date);
```

### 3.1 Phase 1：診斷（到期前 180 天）

**目的：** 全面體檢，找出潛在問題

**自動執行：**
1. 拉取該店最近一次巡店分數
2. 拉取 Google 評價快照
3. 查 Odoo 課程完成率
4. 計算綜合分（加權公式見下方）
5. 分級標記 risk_level

**綜合分計算：**
```
composite = inspection_score × 0.40
          + google_rating × 20 × 0.20     (4.5分 → 90分)
          + course_completion × 0.15
          + improvement_close_rate × 0.15
          + (100 - 1star_penalty) × 0.10   (每個1星扣5分)
```

**分級：**
| composite | risk_level | 行動 |
|-----------|-----------|------|
| ≥ 85 | 🟢 green | 自動通過，標記優質候選 |
| 70-84 | 🟡 yellow | 派發改善任務，120 天複查 |
| 55-69 | 🟠 orange | 重點關注，派發緊急任務 + 安排回訓 |
| < 55 | 🔴 red | 發出預警，通知管理層 |

**自動任務派發：**
- 🟡 yellow → 派「改善弱項照片上傳」任務（最多 5 項）
- 🟠 orange → 派照片 + 「安排回訓」+ 「加開巡店」
- 🔴 red → 同上 + TG 通知 Rick + Robby

### 3.2 Phase 2：複查（到期前 120 天）

**目的：** 確認改善成效

**自動執行：**
1. 重新拉取所有數據
2. 比對 Phase 1 的分數 → 計算變化量
3. 檢查 Phase 1 任務完成率
4. 更新 risk_level

**升降級邏輯：**
- 綜合分上升 ≥ 10 → 降一級風險
- 綜合分未變或下降 → 維持或升一級風險
- 任務完成率 < 50% → 自動升一級風險

### 3.3 Phase 3：裁決（到期前 60 天）

**目的：** 產出續約建議

**自動執行：**
1. 最終數據拉取
2. 綜合三階段歷程
3. 產出建議

**建議分類：**
| 情況 | recommendation | 說明 |
|------|---------------|------|
| 三階段皆 green | `auto_renew` | 自動續約，減免續約金 |
| 改善趨勢正向 | `conditional` | 附條件續約（列具體條件） |
| yellow 未改善 | `review` | 提交管理會議討論 |
| orange/red 未改善 | `terminate` | 建議不續約 |

**輸出：**
- 自動產出 PDF 評估報告（巡店照片 + 評價截圖 + 分數趨勢）
- TG 通知 Rick + Robby：附摘要 + 建議
- Dashboard 續約管理頁面顯示

---

## 四、改善任務閉環

### 新建表

```sql
CREATE TABLE renewal_tasks (
  id SERIAL PRIMARY KEY,
  assessment_id INT REFERENCES renewal_assessments(id),
  store_id INT REFERENCES stores(id),
  store_name TEXT,

  -- 任務類型
  task_type TEXT NOT NULL CHECK (task_type IN (
    'photo_improvement',   -- 上傳改善照片
    'retraining',          -- 預約回訓
    'extra_inspection',    -- 加開巡店
    'document_update',     -- 文件更新（健檢/消防/合約）
    'google_review_response' -- 回覆 Google 負評
  )),

  -- 任務內容
  title TEXT NOT NULL,
  description TEXT,
  related_item_id INT,    -- 關聯的 inspection_item
  related_item_name TEXT,

  -- 狀態
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'in_progress', 'submitted', 'ai_reviewing', 'approved', 'rejected', 'expired')),
  deadline DATE NOT NULL,

  -- 提交
  submitted_at TIMESTAMPTZ,
  submitted_by TEXT,
  submission_data JSONB,   -- 照片 URL、回訓日期等
  submission_photos TEXT[], -- 照片路徑陣列

  -- AI 審核
  ai_review_result JSONB,  -- Vision AI 分析結果
  ai_score NUMERIC(5,2),   -- AI 信心分數
  ai_passed BOOLEAN,

  -- 人工覆核
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  final_status TEXT CHECK (final_status IN ('approved', 'rejected', 'needs_redo')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_renewal_tasks_store ON renewal_tasks(store_id, status);
CREATE INDEX idx_renewal_tasks_deadline ON renewal_tasks(deadline);
```

### 4.1 照片改善任務

**流程：**
```
Agent 派發任務 → LINE 通知店長 → 店長從 Dashboard 上傳照片
→ Vision AI 自動審核 → 通過/退回 → 閉環
```

**Vision AI 審核邏輯：**
```javascript
async function reviewImprovementPhoto(taskId, photos) {
  // 1. 取得原始問題描述
  const task = await getTask(taskId);
  
  // 2. 呼叫 Vision AI（用現有 ai-api-keys.json）
  const prompt = `
    你是泡泡貓品牌督導。這是「${task.related_item_name}」的改善照片。
    原始問題：${task.description}
    
    請判斷：
    1. 問題是否已改善？(yes/no)
    2. 改善程度 (0-100)
    3. 還有什麼需要注意的？
    
    回傳 JSON: { passed: boolean, score: number, notes: string }
  `;
  
  // 3. 多張照片一起送
  const result = await analyzeImages(photos, prompt);
  
  // 4. 信心分 ≥ 85 自動通過；< 85 排入人工覆核
  if (result.score >= 85) {
    await approveTask(taskId, result);
  } else {
    await flagForHumanReview(taskId, result);
  }
}
```

### 4.2 回訓任務

**流程：**
```
Agent 派發 → 通知慈慈（教育訓練）排課
→ 店長/員工參加 → Odoo eLearning 完成記錄 → 閉環
```

### 4.3 提醒機制

| 時機 | 通知對象 | 方式 |
|------|---------|------|
| 任務建立 | 店長 | LINE + Dashboard 紅點 |
| deadline - 3 天 | 店長 | LINE 提醒 |
| deadline 當天 | 店長 + 圓圓 | LINE + TG |
| 逾期 | 店長 + Rick | LINE + TG 告警 |

---

## 五、分級處理邏輯

### 5.1 獎勵機制（green 優質店）

| 條件 | 獎勵 |
|------|------|
| 三階段皆 green + Google ≥ 4.5 | 續約金減免 20% |
| 三階段皆 green | 續約金減免 10% |
| 連續 2 年 green | 額外減免 + 授權「模範店」標章 |
| 巡店 95+ | 年終獎金 +20%（直營店長） |

**自動化：**
- 在 `renewal_assessments.recommendation = 'auto_renew'` 時
- 自動計算減免金額
- 產出續約合約草案（帶減免條款）
- TG 通知 Rick 確認

### 5.2 限縮機制（orange/red 劣質店）

| 風險等級 | 限縮措施 |
|---------|---------|
| 🟠 orange | 增加巡店頻率（季→月）、限制擴店申請 |
| 🔴 red | 暫停新客推廣、凍結加盟權益、啟動輔導 |
| 🔴 red + 未改善 | 終止合作建議 → 管理會議裁決 |

**一票否決清單：**
- 滅火器缺失（消防安全）
- 員工健檢過期（法規）
- 潔面刷發霉（衛生）
- Google 評價 < 3.0
- 嚴重客訴未處理

---

## 六、Cron 排程設計

```
┌─ 每月 1 號 03:00 ──── Google 評價快照
├─ 每天 09:00 ────────── 檢查是否有店到達 180/120/60 天觸發點
├─ 每天 09:30 ────────── 改善任務到期提醒
├─ 每週一 10:00 ──────── 續約狀態週報（TG → Rick + Robby）
└─ 照片上傳後即時 ──── Vision AI 審核（webhook 觸發）
```

---

## 七、Dashboard 整合

### 新增頁面
1. **續約管理** (`/renewal`) — 全覽所有加盟店續約狀態時間軸
2. **評估詳情** (`/renewal/:storeId`) — 三階段評分 + 任務追蹤
3. **任務看板** (`/renewal/tasks`) — 所有改善任務的 Kanban 看板

### 店長端
- `/my` 增加「📋 續約狀態」卡片（顯示倒數天數 + 改善任務）
- 改善照片上傳入口整合在 `/my#improvement`

---

## 八、開發時程

| 階段 | 內容 | 預估時間 |
|------|------|---------|
| **Phase 0** | DB migration + Google Places 串接 | 1 週 |
| **Phase 1** | 三階段預警引擎 + cron | 2 週 |
| **Phase 2** | 改善任務 CRUD + LINE 通知 | 1.5 週 |
| **Phase 3** | Vision AI 審核 + 照片上傳 UI | 1.5 週 |
| **Phase 4** | Dashboard 續約管理頁 + 報表 | 2 週 |
| **Phase 5** | 獎懲自動計算 + 合約草案 | 1 週 |
| **測試 & 調校** | 用歷史資料回測 + Pilot | 1 週 |
| **總計** | | **~10 週** |

### 優先順序
1. 🔴 Phase 0 + Phase 1（核心引擎，有它才能跑）
2. 🟡 Phase 2 + Phase 3（閉環，沒它光預警沒用）
3. 🟢 Phase 4 + Phase 5（錦上添花，可後補）

---

## 九、技術架構圖

```
                    ┌──────────────────────────────┐
                    │     Renewal Quality Agent     │
                    │  (cron: daily 09:00 check)    │
                    └─────────┬────────────────────┘
                              │
              ┌───────────────┼───────────────────┐
              ▼               ▼                   ▼
    ┌─────────────┐  ┌──────────────┐   ┌──────────────┐
    │ 巡店系統     │  │ Google API   │   │ Odoo eLearning│
    │ inspection_* │  │ Places/Reviews│  │ 課程完成度    │
    └──────┬──────┘  └──────┬───────┘   └──────┬───────┘
           │                │                   │
           └────────────────┼───────────────────┘
                            ▼
                  ┌──────────────────┐
                  │ renewal_assessments│
                  │ (三階段評估)       │
                  └────────┬─────────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
           ┌──────────────┐  ┌──────────────┐
           │ renewal_tasks │  │ TG/LINE 通知  │
           │ (改善任務)     │  │ Rick + 店長   │
           └──────┬───────┘  └──────────────┘
                  │
          ┌───────┴────────┐
          ▼                ▼
   ┌─────────────┐  ┌──────────────┐
   │ 照片上傳     │  │ 回訓排課      │
   │ Dashboard    │  │ 通知慈慈      │
   └──────┬──────┘  └──────────────┘
          │
          ▼
   ┌─────────────┐
   │ Vision AI    │
   │ 照片審核     │
   └──────┬──────┘
          │
          ▼
   ┌─────────────────┐
   │ 續約建議報告      │
   │ auto/conditional │
   │ /review/terminate│
   └─────────────────┘
```

---

## 十、風險與注意事項

1. **Google Places API 費用**：每月 ~$15-20（40 間店 × 月抓 1 次 ≈ 40 calls）
2. **Vision AI 費用**：OpenAI Vision 每張 ~$0.01，每月預估 < $5
3. **合約到期日資料**：目前最近到期 2028/1，有充足準備時間
4. **一票否決需人工確認**：AI 建議 `terminate` 時必須人工 final call
5. **隱私**：Google 評論含消費者個資，僅內部使用不外傳
