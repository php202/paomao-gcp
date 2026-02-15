/**
 * Token Web App：以 API 方式提供 SayDou Bearer Token。
 * 現已改由 CoreWebApp.js 統一入口：doGet(e) 時 action 為空或 "token" 即回傳 token。
 * 部署請使用同一個網路應用程式（CoreWebApp 的 doGet/doPost）。
 *
 * 【呼叫端】指令碼屬性：
 * - PAO_CAT_TOKEN_API_URL 或 PAO_CAT_CORE_API_URL = 此專案「網路應用程式」部署網址（結尾 /exec）
 * - PAO_CAT_SECRET_KEY = 與 PaoMao_Core 相同的密鑰
 * 取得 token：GET 部署網址?key=密鑰 或 ?key=密鑰&action=token
 */
