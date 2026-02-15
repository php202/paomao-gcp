/**
 * 針對客人產出接待話語：讀取「客人消費狀態」的 ai prompt，呼叫 AI API 產出 3 句簡短接待話語。
 * 另提供「3 秒鐘接待戰報」：以 aggregateCustomerData(phone) 聚合資料，用 System Prompt 產出戰報並可寫入「AI分析結果」欄。
 * 支援：Google Gemini、OpenAI（GPT-4o mini / GPT-4o）。
 * API Key 請放在「專案設定 → 指令碼屬性」：GEMINI_API_KEY 或 OPENAI_API_KEY，勿寫在程式裡。
 */

var AI_RECEPTION_CONFIG = {
  /** 系統指令：請 AI 扮演接待並依客人歷程產出話語 */
  SYSTEM_INSTRUCTION: "你是美容/SPA 門市接待。請根據以下「客人歷程」產出 3 句簡短、親切的接待話語，讓員工可以直接對這位客人說。每句一行，不要編號。",
  /** Gemini 模型名稱 */
  GEMINI_MODEL: "gemini-2.0-flash",
  /** OpenAI 模型名稱 */
  OPENAI_MODEL: "gpt-4o-mini",
  /** 最長回傳 token（約 200 字內） */
  MAX_TOKENS: 300
};

/** 泡泡貓 (PAO PAO MAO) 品牌結構化資料：供 AI 產出接待戰報與破冰句時引用，勿偏離此資料。 */
var PAOPAO_BRAND_DATASET = [
  "【1. 服務項目】",
  "• 基礎/常態課程：小氣泡(黑頭粉刺清潔、毛孔深層清潔)、水光肌(超滲透補水、保濕潤澤)、光子嫩膚(提亮膚色、晶亮光澤)、超亮眼(眼部護理、輕揉舒壓)、緊緻V(緊緻線條、賦活彈力)。",
  "• 進階/特殊護理：活氧泡泡(肌膚修護，**強調活氧成分**；天山雪蓮為面膜成分，勿當活氧核心)、頸緻人生(頸線拉提、外泌體頸膜)、醫美後援修復計畫(2026新品，雷射/皮秒術後敏感缺水修復，**外泌體為主要功效**，醣醛酸補水修復，約40分鐘)。",
  "• 局部/加購：水潤嘟嘟唇、肌膚檢測、升級逆齡面膜(需滿4項課程以上才可加購)。",
  "【2. 品牌特典】",
  "• 只賣服務不賣產品；泡沖會員價與單項加購價，第二項起享加購價；套票機制(例：醫美後援修復計畫3次套票贈光子嫩膚升級券)。可推薦**儲值享會員優惠**，可體驗更多進階課程。",
  "• 微氣泡科技、高階成分(EGF、天山雪蓮、外泌體、醣醛酸)；總公司有YouTube教育與Odoo維修支援。",
  "【3. 品牌大綱】",
  "• 品牌名：泡泡貓 (PAO PAO MAO)。加盟連鎖，儲值金全門市共用。科技美容與日常保養，非醫療行為，提供醫美術後修復支援。目標客群：注重保濕、清潔、抗老及術後修復，20-45歲。",
  "【4. 話術與禁忌】",
  "• 破冰句請具體對應客人標籤與其做過的課程名稱(如小氣泡、水光肌)，避免空泛問候。",
  "• 水光槍/補水類療程效期約 3-5 天，可據此建議回訪頻率與下次預約話術。",
  "• 品牌不提供精油、不提供按摩；話術與建議勿提及精油或按摩。",
  "• **成分與話術**：活氧泡泡強調活氧成分，勿把天山雪蓮當活氧核心；醫美後援修復計畫強調外泌體主要功效。若客人有醫美**習慣**（非僅需求），可介紹醫美修復課程。",
  "• **操作注意**：小氣泡若怕痛可幫客人**調整吸力**，做產皮/細部清潔時注意力道；勿僅寫「最小號吸頭」。久未回訪可建議**定期小氣泡+水光肌**，維持正常皮膚代謝，居家保養也較好吸收。",
  "• **首訪**：勿出現「昨天幫您服務的美容師」等時序錯亂（首訪無昨日）；可寫「歡迎第一次來到泡泡貓」並推薦儲值享會員優惠。組合方案若含多課程，可註明「含晶淨重啟」等、強調毛孔淨化與代謝。"
].join("\n");

/** 接待戰報用：System Prompt（給 AI 產出「3 秒鐘接待戰報」） */
var AI_BRIEFING_SYSTEM_PROMPT = "你是「泡泡貓」(PAO PAO MAO) 美容中心的資深店長與客戶關係專家。你的任務是閱讀一位客人的破碎資料，並生成一份給美容師看的**「3秒鐘接待戰報」**。\n\n"
  + "【品牌資料集（話術與建議請依此，勿偏離）】\n"
  + PAOPAO_BRAND_DATASET + "\n\n"
  + "資料來源包含：\n"
  + "- 問卷（可能過時）\n"
  + "- Line 對話（可能包含無意義閒聊或內部公告，請自行判斷過濾）\n"
  + "- 消費紀錄（包含關鍵的備註）\n\n"
  + "分析規則：\n"
  + "1. **身分識別（最重要）**：檢查消費備註，確認客人真實身分。如果備註說「不是本人」或有特殊身分（如房東女兒），請放在最顯眼的警示區。\n"
  + "2. **過濾雜訊**：如果 Line 訊息看起來像是系統公告、活動廣播、或是該用戶在發布內部命令，請判定該用戶可能為「內部員工」或「管理層」，並在戰報中標註。\n"
  + "3. **消費偏好**：分析他常做的項目（對應資料集內課程名稱），判斷他是「保養型」、「治療型」還是「術後修復型」客人。\n"
  + "4. **話術規範**：破冰句請具體對應客人做過的課程名稱；水光槍/補水類效期約 3-5 天可引用；品牌不提供精油、不提供按摩，勿提及。**請依品牌資料集【4. 話術與禁忌】**：活氧泡泡強調活氧成分、醫美後援強調外泌體；小氣泡怕痛寫「調整吸力、細部清潔注意力道」勿僅寫最小號吸頭；久未回訪建議「小氣泡+水光肌」維持代謝；首訪勿寫「昨天服務的美容師」等時序錯亂；可推薦儲值享會員優惠；有醫美習慣才介紹醫美修復課程。\n"
  + "5. **剛結帳（間隔 0 天）**：若資料有【消費間隔】且本次距上次為 0 天，請依「歷次回訪間隔」說明回訪節奏並關心最近保養狀況。\n\n"
  + "輸出格式（請只輸出此格式）：\n"
  + "【 ⚡️ 接待戰報：[客人姓名/暱稱] 】\n"
  + "🚨 關鍵注意：[真實身分/地雷區/特殊備註]\n"
  + "💰 消費畫像：[客單價等級] / [偏好項目] / [上次消費距今時間；若剛結帳則另依歷次間隔說明保養關心]\n"
  + "🗣 近期話題與破冰句：[僅放與店內課程/品牌相關的破冰句與話題]\n"
  + "📝 服務建議：[給美容師的一句話，僅引用資料集內課程，勿提精油或按摩；操作注意請依上述話術規範]\n"
  + "💬 額外聊天／新話題：（選填）共鳴話題或店內沒有的東西，例如**醫美新知識**（療程趨勢、術後修復觀念等）、流行、時事、閒聊等。若要當新知識／新話題使用，請另外再開此區塊撰寫，與主戰報分開；無則可省略。";

var AI_BRIEFING_CONFIG = {
  /** OpenAI 戰報用模型（建議 gpt-4o 以產出完整戰報） */
  OPENAI_MODEL: "gpt-4o",
  /** Gemini 戰報用模型 */
  GEMINI_MODEL: "gemini-2.0-flash",
  /** 戰報最長回傳 token */
  MAX_TOKENS: 1500
};

/**
 * 組出要送給 AI 的完整提示（系統 + 客人歷程）
 * @param {string} customerPromptText - 客人消費狀態的「ai prompt」欄全文
 * @returns {string}
 */
function buildReceptionPrompt(customerPromptText) {
  var prefix = AI_RECEPTION_CONFIG.SYSTEM_INSTRUCTION + "\n\n【客人歷程】\n";
  return prefix + (customerPromptText || "（無資料）");
}

/**
 * 從指令碼屬性取得 API Key（專案設定 → 指令碼屬性）
 * @param {string} key - 例如 "GEMINI_API_KEY" 或 "OPENAI_API_KEY"
 * @returns {string|null}
 */
function getApiKeyFromProperties(key) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return (v && v.trim()) ? v.trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * 呼叫 Google Gemini API，依客人歷程產出接待話語
 * @param {string} fullPrompt - buildReceptionPrompt() 的結果
 * @param {string} [apiKey] - 不傳則從指令碼屬性 GEMINI_API_KEY 讀取
 * @returns {string} AI 回傳的接待話語文字
 */
function callGeminiForReception(fullPrompt, apiKey) {
  var key = apiKey || getApiKeyFromProperties("GEMINI_API_KEY");
  if (!key) {
    throw new Error("請在指令碼屬性設定 GEMINI_API_KEY，或傳入 apiKey 參數");
  }
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + AI_RECEPTION_CONFIG.GEMINI_MODEL + ":generateContent?key=" + key;
  var payload = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    generationConfig: {
      maxOutputTokens: AI_RECEPTION_CONFIG.MAX_TOKENS,
      temperature: 0.7
    }
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    throw new Error("Gemini API 錯誤 " + code + ": " + body);
  }
  var data = JSON.parse(body);
  var text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0])
    ? data.candidates[0].content.parts[0].text
    : "";
  return (text || "").trim();
}

/**
 * 呼叫 OpenAI Chat Completions API，依客人歷程產出接待話語
 * @param {string} fullPrompt - buildReceptionPrompt() 的結果
 * @param {string} [apiKey] - 不傳則從指令碼屬性 OPENAI_API_KEY 讀取
 * @returns {string} AI 回傳的接待話語文字
 */
function callOpenAIForReception(fullPrompt, apiKey) {
  var key = apiKey || getApiKeyFromProperties("OPENAI_API_KEY");
  if (!key) {
    throw new Error("請在指令碼屬性設定 OPENAI_API_KEY，或傳入 apiKey 參數");
  }
  var url = "https://api.openai.com/v1/chat/completions";
  var payload = {
    model: AI_RECEPTION_CONFIG.OPENAI_MODEL,
    messages: [
      { role: "system", content: AI_RECEPTION_CONFIG.SYSTEM_INSTRUCTION },
      { role: "user", content: "【客人歷程】\n" + (fullPrompt.replace(/^【客人歷程】\n?/i, "")) }
    ],
    max_tokens: AI_RECEPTION_CONFIG.MAX_TOKENS,
    temperature: 0.7
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: { Authorization: "Bearer " + key },
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    throw new Error("OpenAI API 錯誤 " + code + ": " + body);
  }
  var data = JSON.parse(body);
  var text = (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : "";
  return (text || "").trim();
}

/** 非客人消費狀態的 AI 功能已暫停，僅用於「客人消費狀態」的 AI分析結果 */
var AI_PAUSE_MESSAGE = "（此功能暫停，AI 僅用於客人消費狀態）";

/**
 * 依客人歷程產出接待話語（可選 Gemini 或 OpenAI）
 * 【暫停】目前 AI 僅用於客人消費狀態，此功能不呼叫 API。
 * @param {string} customerPromptText - 客人消費狀態的「ai prompt」欄全文
 * @param {Object} [options] - { provider: "gemini"|"openai", apiKey: "..." }
 * @returns {string} 接待話語文字
 */
function generateReceptionPhrase(customerPromptText, options) {
  return AI_PAUSE_MESSAGE;
}

/**
 * 針對「客人消費狀態」某一列（依手機）產出接待話語並回傳（不寫回試算表）
 * @param {string} phone - 客人手機（會正規化）
 * @param {Object} [options] - { provider: "gemini"|"openai", apiKey: "..." }
 * @returns {string} 接待話語
 */
function generateReceptionPhraseByPhone(phone, options) {
  if (typeof CONFIG === "undefined" || !CONFIG.INTEGRATED_SHEET_SS_ID) {
    throw new Error("需要 CustomerProfile 的 CONFIG（同一專案）");
  }
  var normalized = Core.normalizePhone(phone);
  if (!normalized) throw new Error("無效手機: " + phone);
  var ss = SpreadsheetApp.openById(CONFIG.INTEGRATED_SHEET_SS_ID);
  var sheet = ss.getSheetByName(CONFIG.INTEGRATED_SHEET_NAME);
  if (!sheet) throw new Error("找不到工作表「客人消費狀態」");
  var rowIndex = findRowIndexByPhone(sheet, normalized, CONFIG.INTEGRATED_PHONE_COL);
  if (rowIndex === null) throw new Error("找不到該手機的客人: " + normalized);
  var aiPromptCol = CONFIG.INTEGRATED_HEADERS.indexOf("ai prompt") + 1;
  var customerPromptText = sheet.getRange(rowIndex, aiPromptCol).getValue();
  return generateReceptionPhrase(customerPromptText != null ? String(customerPromptText) : "", options);
}

// ---------------------------------------------------------------------------
// CRM 分析：callAI(dataContext) 串接 Gemini / OpenAI，產出 [真實身分確認]、[消費習慣簡述]、[明日服務建議]
// 僅用於「客人消費狀態」；優先使用 GEMINI_API_KEY，無每日上限（付費額度由使用者自訂）。
// ---------------------------------------------------------------------------

/** CRM 助手 System Prompt：業務導向＋話題共鳴＋回訪週期＋秒懂摘要＋泡泡貓品牌資料集 */
var AI_CRM_SYSTEM_PROMPT = "你是「泡泡貓」(PAO PAO MAO) 美容中心的資深店長與 CRM 助手。請根據傳入的客人資料，產出一份給美容師看的「接待戰報」。\n\n"
  + "【資料集：泡泡貓品牌結構化資料】\n"
  + PAOPAO_BRAND_DATASET + "\n\n"
  + "一、輸出最上方必須有一行「⚡️ 秒懂摘要」\n"
  + "格式：[稱呼] + [關鍵特徵] + [今日最重要任務]。\n"
  + "例：「新手媽媽 / 敏感肌 / 記得問她寶寶睡得好不好，並推銷舒緩課程。」\n\n"
  + "二、話題客製化 (Persona Mapping) 與破冰句\n"
  + "請從資料中讀取或推斷：年齡層、性別、做過的課程名稱、特殊紀錄。\n"
  + "- **破冰句必須具體**：對應客人「做過的課程」(如小氣泡、水光肌、光子嫩膚、活氧泡泡等)，或其標籤(學生/OL/媽媽)，避免空泛問候。例：「上次做水光肌補水，這週膚況有維持住嗎？」、「小氣泡清完粉刺後有沒有按我們教的居家保養？」\n"
  + "- 20-25歲：流行趨勢、美妝、省錢保養、IG打卡。\n"
  + "- 26-35歲：工作舒壓、下班放鬆、精緻生活。\n"
  + "- 30-45歲：育兒經(若有小孩)、Me Time、快速保養效率。\n"
  + "- 男性：乾淨俐落、簡單不麻煩的保養步驟。\n"
  + "- **話術禁忌**：品牌不提供精油、不提供按摩，勿提及精油或按摩。\n\n"
  + "三、回訪週期引導 (Retention Logic)\n"
  + "品牌建議週期為 20-28 天。**水光槍/補水類療程效期約 3-5 天**，若客人常做水光肌等補水課程，可據此建議較密回訪或下次預約話術。\n"
  + "- 小於 20 天：稱讚保養勤勞，重點「維持」。\n"
  + "- 20-28 天 (黃金期)：肯定「這時候做臉效果最好」，直接建議預約下一次。\n"
  + "- 大於 28 天：溫柔提醒「角質層已經堆積了」、「把流失的進度補回來」，詢問是否太忙碌。\n"
  + "- **剛結帳（間隔 0 天）**：填表單常發生在剛結完帳，本次距上次會是 0 天。請改依資料中的「【消費間隔】歷次回訪間隔」觀察回訪節奏與時間長短，在【週期與護理建議】中**另外關心客人最近的保養狀況**（如：上次隔 X 天、再上次隔 Y 天，可提醒居家保養或下次預約節奏）。\n\n"
  + "四、輸出結構請依序包含\n"
  + "1. 【⚡️ 秒懂摘要】一行。\n"
  + "2. 【週期與護理建議】含上次消費日、間隔天數（若為 0 天請另依歷次消費間隔說明回訪節奏與保養關心）、品牌建議週期 20-28 天、水光/補水效期 3-5 天可引用、話術引導與今日重點。\n"
  + "3. 【今日重點】操作注意：小氣泡若怕痛寫「可調整吸力、細部清潔注意力道」勿僅寫最小號吸頭；可推薦課程（僅限資料集內項目），勿提精油或按摩。久未回訪建議「定期小氣泡+水光肌」維持代謝、居家保養好吸收。\n"
  + "4. 【專屬話題攻略】僅放**與店內課程/品牌資料集相關**的破冰句與共鳴話題（對應做過的課程、會員加購、套票等）。勿放店內沒有的療程或產品。\n"
  + "5. 【額外聊天／新話題】（選填）**共鳴話題**或**店內沒有的東西**（例如醫美新知識、流行、時事、閒聊等），若要當新知識／新話題使用，請**另外再開一個**此區塊撰寫，與主戰報分開；主戰報勿混入店外話題，供美容師自行決定是否當額外聊天內容。無則可省略此項。\n\n"
  + "五、注意事項\n"
  + "- 消費紀錄的「備註」權重最高；若有「非本人」、「房東女兒」等字眼，必須在結果中高亮顯示。\n"
  + "- Line 訊息若包含「日報」、「活動文件」、「總公司」，請標記此人可能為內部員工或帳號誤用。\n"
  + "- 若資料中有 SayDou 會員年齡，請納入年齡層判斷。\n"
  + "- 推薦課程與話術請嚴格依上述「泡泡貓品牌結構化資料」，勿虛構療程或成分。\n"
  + "- **話術細節**：活氧泡泡強調活氧成分、醫美後援強調外泌體；有醫美「習慣」才介紹醫美修復課程；首訪勿寫「昨天服務的美容師」；可推薦儲值享會員優惠；組合方案可註明含晶淨重啟、強調毛孔淨化與代謝。";

/**
 * 使用 Gemini API 產出 CRM 分析（與 callAI 相同產出格式）
 * @param {string} userContent - 傳入的資料文字
 * @param {string} [apiKey]
 * @returns {string}
 */
function callGeminiForCRMAnalysis(userContent, apiKey) {
  var key = apiKey || getApiKeyFromProperties("GEMINI_API_KEY");
  if (!key) throw new Error("請在指令碼屬性設定 GEMINI_API_KEY");
  var combined = AI_CRM_SYSTEM_PROMPT + "\n\n---\n\n請根據以下客人資料，依上述格式產出「接待戰報」（含秒懂摘要、週期與護理建議、今日重點、專屬話題攻略；共鳴話題或店內沒有的新知識／新話題請另外寫在「額外聊天／新話題」區塊）。\n\n" + userContent;
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + AI_BRIEFING_CONFIG.GEMINI_MODEL + ":generateContent?key=" + key;
  var payload = {
    contents: [{ role: "user", parts: [{ text: combined }] }],
    generationConfig: {
      maxOutputTokens: AI_BRIEFING_CONFIG.MAX_TOKENS,
      temperature: 0.5
    }
  };
  var options = { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error("Gemini API 錯誤 " + code + ": " + body);
  var data = JSON.parse(body);
  var text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0])
    ? data.candidates[0].content.parts[0].text
    : "";
  return (text || "").trim();
}

/**
 * 串接 OpenAI gpt-4o，依傳入的資料產出 CRM 分析（真實身分確認、消費習慣簡述、明日服務建議）
 * @param {string|Object} dataContext
 * @param {string} [apiKey]
 * @returns {string}
 */
function callOpenAIForCRMAnalysis(dataContext, apiKey) {
  var key = apiKey || getApiKeyFromProperties("OPENAI_API_KEY");
  if (!key) throw new Error("請在指令碼屬性設定 OPENAI_API_KEY");
  var userContent = (typeof dataContext === "object") ? JSON.stringify(dataContext, null, 2) : String(dataContext || "");
  var url = "https://api.openai.com/v1/chat/completions";
  var payload = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: AI_CRM_SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    max_tokens: 1500,
    temperature: 0.5
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: { Authorization: "Bearer " + key },
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error("OpenAI API 錯誤 " + code + ": " + body);
  var data = JSON.parse(body);
  var text = (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : "";
  return (text || "").trim();
}

/**
 * 依傳入的資料產出 CRM 分析。優先使用 GEMINI_API_KEY，無每日上限；失敗則改試 OPENAI_API_KEY。
 * 僅用於「客人消費狀態」的 AI分析結果 欄。
 * @param {string|Object} dataContext - 傳入的 JSON 字串或物件（例如 aggregateCustomerData 產出的文字）
 * @param {string} [apiKey] - 不傳則從指令碼屬性讀取 GEMINI_API_KEY / OPENAI_API_KEY
 * @returns {string} AI 回傳的分析文字
 */
function callAI(dataContext) {
  var userContent = (typeof dataContext === "object") ? JSON.stringify(dataContext, null, 2) : String(dataContext || "");
  var geminiKey = getApiKeyFromProperties("GEMINI_API_KEY");
  var openaiKey = getApiKeyFromProperties("OPENAI_API_KEY");

  if (geminiKey) {
    try {
      return callGeminiForCRMAnalysis(userContent, geminiKey);
    } catch (e) {
      console.warn("Gemini CRM 呼叫失敗，改試 OpenAI: " + (e && e.message));
    }
  }
  if (openaiKey) {
    return callOpenAIForCRMAnalysis(userContent, openaiKey);
  }
  throw new Error("請在指令碼屬性設定 GEMINI_API_KEY 或 OPENAI_API_KEY");
}

// ---------------------------------------------------------------------------
// 3 秒鐘接待戰報：aggregateCustomerData + AI（OpenAI gpt-4o / Gemini）
// ---------------------------------------------------------------------------

/**
 * 呼叫 OpenAI Chat Completions API，產出「3 秒鐘接待戰報」
 * @param {string} systemPrompt - AI_BRIEFING_SYSTEM_PROMPT
 * @param {string} userContent - aggregateCustomerData(phone) 的結果
 * @param {string} [apiKey]
 * @returns {string} 戰報文字
 */
function callOpenAIForBriefing(systemPrompt, userContent, apiKey) {
  var key = apiKey || getApiKeyFromProperties("OPENAI_API_KEY");
  if (!key) throw new Error("請在指令碼屬性設定 OPENAI_API_KEY，或傳入 apiKey 參數");
  var url = "https://api.openai.com/v1/chat/completions";
  var payload = {
    model: AI_BRIEFING_CONFIG.OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ],
    max_tokens: AI_BRIEFING_CONFIG.MAX_TOKENS,
    temperature: 0.5
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: { Authorization: "Bearer " + key },
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error("OpenAI API 錯誤 " + code + ": " + body);
  var data = JSON.parse(body);
  var text = (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : "";
  return (text || "").trim();
}

/**
 * 呼叫 Google Gemini API，產出「3 秒鐘接待戰報」
 * @param {string} systemPrompt - AI_BRIEFING_SYSTEM_PROMPT
 * @param {string} userContent - aggregateCustomerData(phone) 的結果
 * @param {string} [apiKey]
 * @returns {string} 戰報文字
 */
function callGeminiForBriefing(systemPrompt, userContent, apiKey) {
  var key = apiKey || getApiKeyFromProperties("GEMINI_API_KEY");
  if (!key) throw new Error("請在指令碼屬性設定 GEMINI_API_KEY，或傳入 apiKey 參數");
  var combined = systemPrompt + "\n\n---\n\n請根據以下客人資料產出「3秒鐘接待戰報」：\n\n" + userContent;
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + AI_BRIEFING_CONFIG.GEMINI_MODEL + ":generateContent?key=" + key;
  var payload = {
    contents: [{ role: "user", parts: [{ text: combined }] }],
    generationConfig: {
      maxOutputTokens: AI_BRIEFING_CONFIG.MAX_TOKENS,
      temperature: 0.5
    }
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error("Gemini API 錯誤 " + code + ": " + body);
  var data = JSON.parse(body);
  var text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0])
    ? data.candidates[0].content.parts[0].text
    : "";
  return (text || "").trim();
}

/**
 * 依手機產出「3 秒鐘接待戰報」並回傳（不寫回試算表）
 * 【暫停】目前 AI 僅用於客人消費狀態（callAI 寫入 AI分析結果），此功能不呼叫 API。
 * @param {string} phone - 客人手機（會正規化）
 * @param {Object} [options] - { provider: "gemini"|"openai", apiKey: "..." }
 * @returns {string} 戰報文字
 */
function generateReceptionBriefingByPhone(phone, options) {
  return "";
}

/**
 * 依手機產出「3 秒鐘接待戰報」並寫入「客人消費狀態」的「AI分析結果」欄
 * 【暫停】目前 AI 僅由 refreshCustomerByPhone / 表單送出 的 callAI 寫入，此函式不呼叫 API、不寫入。
 * @param {string} phone - 客人手機（會正規化）
 * @param {Object} [options] - { provider: "gemini"|"openai", apiKey: "..." }
 * @returns {string} 空字串
 */
function generateReceptionBriefingByPhoneAndWrite(phone, options) {
  return "";
}

// ---------------------------------------------------------------------------
// 明日上班前 Push 給該店主管：產出明日預約客人 + AI 分析，供主管更了解客人需求
// 實際 LINE Push 請在此結果上串接（參考 TomorrowReservationReport.pushTomorrowReportToManagers），待您確認後再實作。
// ---------------------------------------------------------------------------

/**
 * 針對明日預約客人，依手機取得聚合資料並呼叫 callAI，產出各店、各客人的 [真實身分確認]、[消費習慣簡述]、[明日服務建議]。
 * 回傳結構可再串接「Push 給該店主管」（LINE），待您檢查後再實作 Push。
 * @param {string} [dateStr] - yyyy-MM-dd，不傳則用明天
 * @returns {Object} { dateStr, byStore: [{ storeId, storeName, items: [{ phone, name, rsvtim, staffName, services, aiResult }] }] }
 */
function buildTomorrowBriefingForManagers(dateStr) {
  if (!dateStr) {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateStr = Utilities.formatDate(tomorrow, "Asia/Taipei", "yyyy-MM-dd");
  }
  var options = (arguments.length >= 2 && arguments[1] != null) ? arguments[1] : {};
  var token = (options.token != null && options.token !== "") ? options.token : "";
  var byStore = typeof getTomorrowReservationsByStore === "function" ? getTomorrowReservationsByStore(dateStr, { token: token }) : [];
  var out = { dateStr: dateStr, byStore: [] };
  for (var i = 0; i < byStore.length; i++) {
    var block = byStore[i];
    var storeId = block.storeId;
    var storeName = block.storeName || ("店" + storeId);
    var items = block.items || [];
    var storeResults = [];
    for (var j = 0; j < items.length; j++) {
      var o = items[j];
      var phone = o.phone;
      var name = o.name || "—";
      var rsvtim = o.rsvtim || "";
      var timeText = o.timeText || "";
      if (!timeText && rsvtim) {
        var tPart = String(rsvtim).split(/[T\s]/)[1] || "";
        timeText = tPart.slice(0, 5);
      }
      var staffName = o.staffName || "";
      var services = o.services || "";
      var aiResult = "";
      // 【暫停】AI 僅用於客人消費狀態（refreshCustomerByPhone / 表單送出 的 callAI）；明日預約報告不呼叫 AI。
      // if (phone && typeof aggregateCustomerData === "function" && typeof callAI === "function") { ... }
      storeResults.push({
        phone: phone || "",
        name: name,
        rsvtim: rsvtim,
        timeText: timeText,
        staffName: staffName,
        services: services,
        aiResult: aiResult
      });
    }
    out.byStore.push({
      storeId: storeId,
      storeName: storeName,
      items: storeResults
    });
  }
  return out;
}

/**
 * 產出「明日預約 + AI 簡略說明」的純文字（供 LINE 回覆用），只含指定店家的預約。
 * @param {string[]} managedStoreIds - 負責店家 ID 或名稱（與 getTomorrowReservationsByStore 的 storeId/storeName 比對）
 * @returns {string} 一段可直貼 LINE 的文字
 */
function getTomorrowBriefingTextForStores(managedStoreIds) {
  if (!managedStoreIds || managedStoreIds.length === 0) {
    return "明日預約（AI 簡略）：請提供負責店家 ID。";
  }
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dateStr = Utilities.formatDate(tomorrow, "Asia/Taipei", "yyyy-MM-dd");
  if (typeof isTomorrowReportClosed === "function" && isTomorrowReportClosed(dateStr)) {
    return "明日預約報告 " + dateStr + " 已關閉，當日不提供報告。";
  }
  var briefing = buildTomorrowBriefingForManagers(dateStr);
  var storeIdSet = {};
  managedStoreIds.forEach(function (id) { storeIdSet[String(id).trim()] = true; });
  var lines = ["📅 明日預約 " + briefing.dateStr + "（含 AI 簡略）", ""];
  for (var i = 0; i < briefing.byStore.length; i++) {
    var block = briefing.byStore[i];
    var idMatch = storeIdSet[block.storeId] || storeIdSet[block.storeName];
    if (!idMatch) continue;
    lines.push("【" + block.storeName + "】");
    if (!block.items || block.items.length === 0) {
      lines.push("（無預約）");
      lines.push("");
      continue;
    }
    for (var j = 0; j < block.items.length; j++) {
      var o = block.items[j];
      lines.push("・" + (o.name || "—") + " " + (o.rsvtim || "") + " " + (o.staffName || ""));
      if (o.services) lines.push("  課程：" + (o.services || "").replace(/\n/g, " "));
      if (o.aiResult) lines.push("  AI：" + (o.aiResult || "").replace(/\n/g, " ").slice(0, 500));
      lines.push("");
    }
  }
  if (lines.length <= 2) return "明日預約（AI 簡略）：您負責的店家明日無預約或無資料。";
  return lines.join("\n").trim();
}

/**
 * Web App 用：doGet(e) 的 action=getTomorrowBriefing，讀取 storeIds 參數，回傳明日預約 + AI 簡略（純文字）
 * @param {Object} e - doGet 的 event，e.parameter.storeIds 為逗號分隔的店家 ID
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function getTomorrowBriefingAction(e) {
  var storeIdsParam = (e && e.parameter && e.parameter.storeIds) ? String(e.parameter.storeIds).trim() : "";
  var storeIds = storeIdsParam ? storeIdsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var text = getTomorrowBriefingTextForStores(storeIds);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

/** 明日預約報告關閉日（當日不提供預約清單／報告），格式 yyyy-MM-dd */
var TOMORROW_REPORT_CLOSED_DATES = ["2026-02-04"];

function isTomorrowReportClosed(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return false;
  var d = String(dateStr).trim();
  return TOMORROW_REPORT_CLOSED_DATES.indexOf(d) >= 0;
}

/**
 * Web App 用：doGet(e) 的 action=getTomorrowReservationList，讀取 storeIds 參數，回傳明日預約清單（JSON）供 LINE Carousel 使用。
 * @param {Object} e - doGet 的 event，e.parameter.storeIds 為逗號分隔的店家 ID
 * @returns {GoogleAppsScript.Content.TextOutput} JSON { dateStr, byStore: [ ... ], closed?: boolean, message?: string }
 */
function getTomorrowReservationListAction(e) {
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dateStr = Utilities.formatDate(tomorrow, "Asia/Taipei", "yyyy-MM-dd");
  if (isTomorrowReportClosed(dateStr)) {
    var out = { dateStr: dateStr, byStore: [], closed: true, message: "明日預約報告 " + dateStr + " 已關閉，當日不提供預約清單。" };
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }
  var storeIdsParam = (e && e.parameter && e.parameter.storeIds) ? String(e.parameter.storeIds).trim() : "";
  var storeIds = storeIdsParam ? storeIdsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var token = (typeof CoreApi !== "undefined" && CoreApi.getBearerToken) ? (function () { try { return CoreApi.getBearerToken(); } catch (err) { return ""; } })() : "";
  var briefing = typeof buildTomorrowBriefingForManagers === "function" ? buildTomorrowBriefingForManagers(dateStr, { token: token }) : { dateStr: dateStr, byStore: [] };
  var storeIdSet = {};
  storeIds.forEach(function (id) { storeIdSet[String(id).trim()] = true; });
  var byStore = (briefing.byStore || []).filter(function (b) {
    return storeIdSet[b.storeId] || storeIdSet[b.storeName || ""];
  });
  if (!briefing.dateStr) briefing.dateStr = dateStr;
  dateStr = briefing.dateStr || "";
  // 每店查明日可預約空位：參照「訊息一覽搜尋空位」邏輯（Action-getSlots cleanData），與查詢空位結果一致
  if (dateStr && typeof cleanData === "function") {
    for (var i = 0; i < byStore.length; i++) {
      var store = byStore[i];
      var slotsText = "—";
      try {
        var fullText = cleanData(store.storeId, { startDate: dateStr, endDate: dateStr });
        if (fullText && typeof fullText === "string") {
          var firstLine = fullText.split("\n")[0];
          if (firstLine && firstLine.indexOf("）：") >= 0) {
            slotsText = firstLine.split("）：")[1].trim();
          } else if (firstLine && firstLine.trim()) {
            slotsText = firstLine.trim();
          }
        }
      } catch (err) {
        var errMsg = (err && err.message) ? err.message : String(err);
        console.warn("getTomorrowReservationList 空位查詢拋錯 [" + (store.storeName || store.storeId) + "]: " + errMsg);
      }
      // 有實際時段才顯示「1.5hr 還有 n 個空位」；無空位或查不到時回傳「—」，LINE 不顯示該行
      if (slotsText && slotsText !== "—" && slotsText !== "（無）") {
        var n = slotsText.split("、").filter(function (s) { return s && String(s).trim(); }).length;
        store.availableSlotsText = n > 0 ? "1.5hr 還有 " + n + " 個空位" : "—";
      } else {
        store.availableSlotsText = "—";
      }
    }
  } else {
    for (var j = 0; j < byStore.length; j++) byStore[j].availableSlotsText = "—";
  }
  // 為每位客人產生一次性 token（點擊手機連結用，防止被人改手機號盜用）
  if (typeof createCustomerCardToken === "function") {
    for (var si = 0; si < byStore.length; si++) {
      var items = byStore[si].items || [];
      for (var ii = 0; ii < items.length; ii++) {
        var ph = items[ii].phone;
        if (ph) items[ii].token = createCustomerCardToken(ph) || "";
      }
    }
  }
  var out = { dateStr: dateStr, byStore: byStore };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
