// ==UserScript==
// @name         SayDou Token Sync (Token 自動同步器) - GCP 版
// @namespace    http://tampermonkey.net/
// @version      2026-01-12
// @description  自動攔截 Authorization Token 並同步到 GCP（寫入 Token 試算表）
// @author       You
// @match        *://m.saydou.com/*
// @match        *://saywebdatafeed.saydou.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';
    const currentUrl = window.location.href;
    if (/login/i.test(currentUrl)) {
        console.log("偵測到 login 頁面，Token 監聽器不啟動。");
        return;
    }
    console.log("Token 監聽器已啟動 (GCP)...");

    // 改成你的 GCP 服務網址（例如 Cloud Run 的 URL）
    const GCP_SAYDOU_TOKEN_URL = "https://YOUR_PROJECT.run.app/saydou-token";
    // 若 GCP 有設 SAYDOU_TOKEN_SYNC_KEY，請填在這裡（可選）
    const SYNC_KEY = "";

    let lastSentToken = "";

    const { fetch: originalFetch } = window;
    window.fetch = async (...args) => {
        const [resource, config] = args;
        if (config && config.headers && (config.headers.Authorization || config.headers.authorization)) {
            const token = config.headers.Authorization || config.headers.authorization;
            syncTokenToGCP(token);
        }
        return originalFetch(...args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (header.toLowerCase() === 'authorization') syncTokenToGCP(value);
        return originalSetRequestHeader.apply(this, arguments);
    };

    function syncTokenToGCP(tokenString) {
        let cleanToken = tokenString.replace(/^Bearer\s+/i, "").trim();
        if (!cleanToken || cleanToken === lastSentToken) return;

        console.log("抓到新 Token! 準備同步到 GCP...");
        let url = GCP_SAYDOU_TOKEN_URL;
        if (SYNC_KEY) url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(SYNC_KEY);

        const headers = { "Content-Type": "application/json" };
        if (SYNC_KEY) headers["X-Saydou-Token-Sync-Key"] = SYNC_KEY;

        GM_xmlhttpRequest({
            method: "POST",
            url,
            headers,
            data: JSON.stringify({ token: cleanToken }),
            onload: function(response) {
                console.log("Token 同步成功: " + response.responseText);
                lastSentToken = cleanToken;
            },
            onerror: function(err) {
                console.error("Token 同步失敗", err);
            }
        });
    }
})();
