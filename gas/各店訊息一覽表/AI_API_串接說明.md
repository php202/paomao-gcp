# 針對客人產出接待話語：AI API 串接說明

「客人消費狀態」的 **ai prompt** 欄已彙整該客人的完整歷程（員工填寫、問卷、LINE 對話、消費與儲值紀錄），可傳給 AI 產出**員工對這位客人該怎麼說話**的接待話語。

---

## 要不要付費？

- **不用付費也能測試**：用 **Google Gemini API 免費版** 即可，有每月約 100 萬 token 免費額度，足夠開發與小量上線。
- **正式或高用量**：再考慮付費方案（Gemini / OpenAI / Claude 等按用量計費）。

---

## 推薦可串接的 AI API

| 方案 | 免費額度 | 付費 | 串接難度 | 說明 |
|------|----------|------|----------|------|
| **Google Gemini** | 有（約 100 萬 token/月，有 RPM 限制） | 按用量 | ⭐ 簡單 | 同為 Google 生態，GAS 用 `UrlFetchApp` 打 REST 即可，建議優先試 |
| **OpenAI（GPT-4o / GPT-4o mini）** | 新帳號有少量免費額度 | 按 token | ⭐ 簡單 | 文件多、範例多，GAS 一樣用 `UrlFetchApp` POST 即可 |
| **Anthropic Claude** | 有免費試用 | 按 token | ⭐ 簡單 | 同樣 REST API，GAS 可串 |
| **OpenRouter / GetGoAPI 等** | 依平台 | 統一多模型計費 | ⭐ 簡單 | 一次串接可換多種模型（OpenAI、Claude、Gemini 等） |

**建議**：先到 [Google AI Studio](https://aistudio.google.com/app/apikey) 申請 **Gemini API Key**（免費），用本專案內的 `AiReception.js` 做「針對這位客人產出接待話語」的串接測試；確認流程後再視需要加 OpenAI 或 Claude。

---

## 串接方式（Google Apps Script）

1. **API Key 存放**：不要寫在程式裡。用 **Script 屬性**（檔案 → 專案設定 → 指令碼屬性）新增例如 `GEMINI_API_KEY`，或放在 Core 的設定試算表（需自行讀取）。
2. **發送請求**：用 `UrlFetchApp.fetch(url, options)` 對各家的 Chat/Completion API 發 POST，body 為 JSON（model、messages 或 prompt、max_tokens 等）。
3. **解析回傳**：從回應 JSON 取出 `choices[0].message.content`（OpenAI）或 `candidates[0].content.parts[0].text`（Gemini），即為 AI 產出的接待話語。

本專案已提供 **AiReception.js** 範例：讀取「客人消費狀態」的 ai prompt → 組成給 AI 的提示 → 呼叫 Gemini 或 OpenAI → 回傳接待話語，可依此改為 Claude 或 OpenRouter。

---

## 參考連結

- [Google AI Studio 申請 API Key](https://aistudio.google.com/app/apikey)
- [Gemini API 定價與額度](https://ai.google.dev/gemini-api/docs/pricing)
- [OpenAI API 文件](https://platform.openai.com/docs/api-reference)
- [Anthropic Claude API](https://docs.anthropic.com/claude/reference)
