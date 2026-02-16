# GAS → GCP 細節與邏輯對照檢查清單

本文對照 GAS 各模組與 GCP 實作，列出**細節功能**與**邏輯判斷**的差異，並標示已補齊／待補／選用。

---

## 一、各店訊息一覽表（Store LINE Webhook）

| 項目 | GAS 行為 | GCP 現狀 | 狀態 |
|------|----------|----------|------|
| **messFilter 規則** | 我的會員、課程介紹、送出預約、線上預約、您已取消預約 | 同左，規則一致 | ✅ |
| **不寫挽留／不寫訊息一覽** | 會員權益、了解課程 不寫挽留；選單觸發不寫訊息一覽 | 同左；目前挽留清單不寫入（僅線上預約傳訊） | ✅ |
| **僅線上預約傳訊** | 查詢空位時查空位＋模板＋立即 Reply（I 欄 isReply） | 同左：僅「線上預約」回傳空位文案，其餘選單不傳訊 | ✅ |
| **空位無資料時** | "Hi ${name}，近幾天都滿了，可以呼叫貓小編…" | 同左 | ✅ |
| **訊息一覽欄位** | 時間、userId、店家、名字、訊息、狀態、…、replyToken | 同左；時間為 Asia/Taipei | ✅ |
| **syncLineUserIdForPhoneToCustomerState** | 有手機時同步到「客人消費狀態」lineUserId 欄 | 選用：可另接 | ⚠️ 選用 |
| **postback** | event.type===postback、action=book_reengagement → 一鍵預約 | 未處理 postback | ❌ 待補 |
| **準客挽留清理** | 每 10 天執行、刪已結案 + 逾 7 天 Pending | scripts/cleanup-retention-list.js | ✅ |

---

## 二、泡泡貓員工打卡 Line@（Staff Webhook）

| 項目 | GAS 行為 | GCP 現狀 | 狀態 |
|------|----------|----------|------|
| **我要打卡** | 回傳請傳送位置 | 同左 | ✅ |
| **查詢打卡記錄** | Quick Reply 本月/上月/店家今天/本月/上月/可預約時間 | 同左 | ✅ |
| **出勤指令** | 店家今天出勤、店家本月出勤、店家上月出勤、本月出勤、上月出勤、店家可預約時間 | 同左 | ✅ |
| **本月/上月出勤 顯示格式** | getAtt.js formatAtt()：👤 員工: 姓名 (店名)、🔹 日期 出勤紀錄、✅ 上班/下班 HH:mm:ss | buildAttendanceMessage 對齊 formatAtt；店名由 getStoreDisplayName(storeNameMap) 解析，日期排序 | ✅ |
| **最新活動 / 特約商店 / 我要開店** | 文字+連結或 Quick Reply | 同左 | ✅ |
| **Line問題集** | 讀 LINE_HQ_SS_ID 問題集、待處理列表 | 同左 | ✅ |
| **店家回覆狀態** | 僅管理者、直營店未回覆數與完成率 | 同左 | ✅ |
| **明天/明日預約清單** | 管理者看 managedStores、員工看 workStores；Flex 或文字+Quick Reply；店名由 API 或 Core 回傳 | 同左；**店別一律用 getStoreDisplayName**：店家對照表→API 店名→「店碼 xxx」，不得顯示【0001】等代碼 | ✅ |
| **明日預約（僅四字）** | 回「此功能暫時關閉，敬請見諒。」 | 已補：完全匹配時同左 | ✅ |
| **我要了解客人 + 手機** | Core getCustomerAIResult，回傳 AI 分析結果 | 同左（callCoreApiPost） | ✅ |
| **上月小費** | Core lastMonthTipsReport，回報表連結 | 同左 | ✅ |
| **神美日報** | Core createReportToken，回按鈕開啟日報 | 同左 | ✅ |
| **我要註冊** | 權限前處理；已開通→勿重複；審核中→勿重複；解析姓名、比對員工清單 C、寫請求員工ID A~F | 已補：handleRegisterRequest，邏輯一致；審核中檢查 B 欄 userId | ✅ |
| **補打卡** | 僅「補打卡」→ 範本；含「補登時間」「輸入上/下班」→ 解析寫入員工打卡紀錄、備註「📝補打卡」；時間以台北解讀 | 已補：handleMakeUpTime；補登時間解析為 Asia/Taipei（+08:00）；B 欄寫台北時間字串 | ✅ |
| **報告關鍵字** | Core getReportHandlerFromKeyword + getReportTextForKeyword（目前 Core 關閉不產出） | 未呼叫；可選補上與 GAS 一致 | ⚠️ 選用 |
| **工作流程連結** | Core.getWorkflowLink(keyword) → 回「請點擊: url」 | 已補：讀 公司流程 試算表或呼叫 Core（若暴露） | ✅ |
| **eventId 重複攔截** | Cache 60 秒避免 LINE 重試重複處理 | 已實作：lib/line-webhook.js isDuplicateLineEvent + server.js 員工 webhook 迴圈 | ✅ |

---

## 三、PaoMao_Core API 對應

| GAS Core action | GCP 實作 | 備註 |
|-----------------|----------|------|
| lineReply | 各店/員工各自打 LINE API，不經 Core | ✅ |
| getCustomerAIResult | core-api 無；員工端 callCoreApiPost 打 GAS Core | 依賴 LEGACY_GAS_CORE_API_URL |
| findAvailableSlots | core-api findAvailableSlotsAction | ✅ |
| createReportToken | core-api 有 | ✅ |
| lastMonthTipsReport | core-api 轉 GAS 或自實作 | ✅ |
| getWorkflowLink | GAS 未對外；GCP 自讀試算表 公司流程 | ✅ |

---

## 四、排程／腳本

| 項目 | GAS | GCP | 狀態 |
|------|-----|-----|------|
| 準客挽留清理 | Triggers 每 10 天 cleanupRetentionList | scripts/cleanup-retention-list.js | ✅ |
| 候補自動推播 | runWaitlistAutoPush | scripts/waitlist-auto-push.js | ✅ |
| 逾時 Pending 檢查 | Auto-checkTimeout | scripts/check-timeout-pending.js | ✅ |

---

## 五、GAS「先產出再顯示」邏輯（資料面）

| 情境 | GAS 行為 | 說明 |
|------|----------|------|
| **明日預約清單** | 資料來自 SayDou API（Core.fetchReservationsAndOffs），即時拉取 | 清單本身無「無資料時先產出」；若當日關閉則回「明日預約報告當日已關閉」 |
| **客人狀態頁（customer-info）** | 查無此客人時，先呼叫 refreshCustomerByPhone 產出該手機的資料（寫入「客人消費狀態」），再顯示 | 若仍無列則回「查無此客人…已嘗試產出資料」 |
| **每日 22:00 排程** | refreshCustomersByTomorrowReservations：取得明日預約清單 → 對每支手機執行 refreshCustomerByPhone | 預先產出客人消費狀態，明日上班前主管看「我要了解客人」時已有資料 |

GCP 明日預約清單僅呼叫 TOMORROW_BRIEFING_WEB_APP_URL 或 getTomorrowReservationList，不負責產出；產出由 GAS 排程／客人狀態頁處理。

---

## 六、待補／選用彙整

- **待補**：Store Webhook **postback action=book_reengagement**（一鍵預約回訪）。
- **選用**：syncLineUserIdForPhoneToCustomerState、DisplayNameDB/群組 member、findStore 自動填 E 欄、報告關鍵字。

完成上述「待補」後，與 GAS 的細節與邏輯對齊即足夠供 cutover 使用；選用項可依需求再補。
