# 明日預約 + AI 簡略說明

## 1. 直接更新清單就能看到最新客戶狀況？

可以。不用等排程，手動執行以下任一函式即可：

| 方式 | 函式 | 說明 |
|------|------|------|
| 整表更新 | `refreshAllCustomersByPhone` | 依「客人消費狀態」每一列手機，重拉員工填寫、問卷、訊息、SayDou，更新該列 |
| 單一客人 | `refreshCustomerByPhone(phone)` | 只更新一支手機的整合資料 |
| 明日預約客人 | `refreshCustomersByTomorrowReservations` | 只更新「明天有預約」的客人（22:00 排程也會跑這個） |

**執行方式**：Apps Script 編輯器選函式 → 執行；或選單綁定後從試算表觸發。

---

## 2. 打「明日預約」就得到負責店家的 AI 簡略說明？

**目前 AI 僅用於「客人消費狀態」**。打「明日預約」會回傳明日預約名單，但**不含**每位客人的 AI 簡略（此功能已暫停，避免重複呼叫 AI）。

若日後要恢復「明日預約 + AI 簡略」，需完成：

1. **各店訊息一覽表** 部署成 **Web App**（執行身分：我、誰可存取：任何人）。
2. 複製部署後的網址（例：`https://script.google.com/macros/s/xxxx/exec`）。
3. 在 **PaoMao_Core/Config.js** 裡把 `TOMORROW_BRIEFING_WEB_APP_URL` 設成該網址，然後 `clasp push`。
4. **泡泡貓 員工打卡 Line@** 也需 `clasp push`（已改為：有設網址時會先呼叫該 Web App 取明日預約+AI）。

若**未設** `TOMORROW_BRIEFING_WEB_APP_URL`，打「明日預約」仍會回傳明日預約報告，但**不含** AI 簡略（沿用 Core 原報告）。

---

## 3. 需要給你 API Key 嗎？

**不用**。API Key 是放在 **Google Apps Script 的「指令碼屬性」**，不是給 Cursor／AI。

1. 開啟 **各店訊息一覽表** 專案 → 左側齒輪 **專案設定**。
2. **指令碼屬性** → 新增屬性：  
   - **GEMINI_API_KEY**（優先）：值為您的 Google Gemini API Key，`callAI`（客人消費狀態）會優先使用，無每日上限（付費額度由您自訂）。  
   - **OPENAI_API_KEY**（選填）：當未設 Gemini 或呼叫失敗時，改用此 Key 呼叫 gpt-4o。
3. 存檔後，**僅「客人消費狀態」的 AI分析結果** 會使用上述 Key（Gemini 優先 → OpenAI）。

（Key 只存在您的 GAS 專案裡，不會寫進程式碼或給別人。）

---

## 4. AI 建議何時寫入「客人消費狀態」？會一直重跑嗎？

**不會**。為節省 API 額度與成本，AI 只會在「**該筆 A 欄時間戳記有被更新**」時才跑並寫入「AI分析結果」：

- **手動／排程重整單一客人**：`refreshCustomerByPhone(phone)` 會先更新該列（含時間），再跑 AI 並寫入該列。
- **表單送出**：員工送出問卷後會 upsert 該列（時間更新），接著只對該筆跑 AI 並寫入。
- **明日預約 22:00 排程**：只對「明日有預約」的客人執行 `refreshCustomerByPhone`，因此只會對這些客人更新時間並跑 AI。

整表 `refreshAllCustomersByPhone` 時，每一列都會更新時間，因此每列都會嘗試跑 AI（無每日上限，額度由您自訂）。

---

## 5. AI 目前用在哪些地方？哪些已暫停？

| 位置 | 用途 | 狀態 |
|------|------|------|
| **CustomerProfile.js** | `refreshCustomerByPhone` / 表單送出後 → `callAI` 寫入「AI分析結果」 | ✅ **使用中**（僅此處會呼叫 AI） |
| **AiReception.js** | `buildTomorrowBriefingForManagers` 明日預約每位客人的 AI 簡略 | ⏸ 暫停 |
| **AiReception.js** | `generateReceptionPhrase` / `generateReceptionPhraseByPhone` 接待話語（3 句） | ⏸ 暫停 |
| **AiReception.js** | `generateReceptionBriefingByPhone` / `generateReceptionBriefingByPhoneAndWrite` 3 秒鐘戰報 | ⏸ 暫停 |
| **Post-handleLineWebhook.js** | `generateContextualAI` LINE 回覆的客服文案 | ⏸ 暫停（改回罐頭訊息） |

---

## 6. 預約／空位相關

### 空位顯示與後台一致

- **問題**：LINE 查空位顯示的時段，與後台「很多時段已預約滿」不一致。
- **修正**：空位計算改為**凡有預約（含待確認）都算佔用**，與 SayDou 後台邏輯對齊；Core 與各店訊息一覽表（getSlots / createBooking）皆已改為不只看「已確認」預約。

### 客人預約通知按「確認」後被消掉

- **現象**：客人收到預約通知後按「確認」，預約被取消或消失。
- **說明**：預約通知與「確認」按鈕由 **SayDou** 推播／後台流程處理，非本 GAS 發送。若按「確認」會觸發取消，可能是 SayDou 端流程設計（例如「確認」被當成「取消」或觸發了取消 API）。
- **建議**：與 **SayDou 原廠** 確認：客人按「確認」後預期行為是「確認出席」還是會觸發取消；必要時請他們調整推播或後台流程，避免每位客人都需打電話才能取消。
