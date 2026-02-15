// ==UserScript==
// @name         SayDou Token Sync (Token 自動同步器)
// @namespace    http://tampermonkey.net/
// @version      2026-01-12
// @description  自動攔截 Authorization Token 並同步到 GAS
// @author       You
// @match        *://m.saydou.com/*
// @match        *://saywebdatafeed.saydou.com/*
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/SayDou-Token-Sync.user.js
// @downloadURL  https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/SayDou-Token-Sync.user.js
// ==/UserScript==

(function() {
    'use strict';
    const currentUrl = window.location.href;
    // 依實際網址調整：只要網址裡含有 login / Login 就直接結束
    if (/login/i.test(currentUrl)) {
        console.log("偵測到 login 頁面，Token 監聽器不啟動。");
        return;
    }
    console.log("Token 監聽器已啟動...");

    // 設定你的 GAS Web App 網址
    const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbylWApG-4rne8crGM8CxfN_BIjNvZt4U9KU6RNigzj7ploTEm84p2JmZwLTMFlLMQBp/exec";

    let lastSentToken = ""; // 避免重複發送相同的 Token

    // --- 攔截 Fetch 請求 (現代網站主要用這個) ---
    const { fetch: originalFetch } = window;
    window.fetch = async (...args) => {
        const [resource, config] = args;

        // 檢查 request header 裡面有沒有帶 Authorization
        if (config && config.headers && (config.headers.Authorization || config.headers.authorization)) {
            const token = config.headers.Authorization || config.headers.authorization;
            syncTokenToGAS(token);
        }

        return originalFetch(...args);
    };

    // --- 攔截 XHR 請求 (舊版 AJAX 或是某些套件會用這個) ---
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url; // 紀錄一下網址供除錯
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        // 如果 header 是 Authorization，那就是我們要的 Token
        if (header.toLowerCase() === 'authorization') {
            syncTokenToGAS(value);
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    // --- 傳送 Token 到 Google Apps Script 的函式 ---
    function syncTokenToGAS(tokenString) {
        // 簡單處理：如果包含 "Bearer " 字串，只取後面的亂碼，或者整串傳過去由 GAS 處理也可以
        // 這裡我們假設整串傳過去 (e.g. "Bearer eyJhbGci...")

        let cleanToken = tokenString.replace(/^Bearer\s+/i, "").trim();
        if (!cleanToken || cleanToken === lastSentToken) {
            return; // Token 沒變，或是空的，就不傳送，節省資源
        }

        console.log("抓到新 Token! 準備同步...");

        // 使用 GM_xmlhttpRequest 可以跨網域傳送資料 (避開 CORS 問題)
        GM_xmlhttpRequest({
            method: "POST",
            url: GAS_WEB_APP_URL,
            headers: {
                "Content-Type": "application/json"
            },
            data: JSON.stringify({ token: cleanToken }),
            onload: function(response) {
                console.log("Token 同步成功: " + response.responseText);
                lastSentToken = cleanToken; // 更新快取，避免下次重複傳
            },
            onerror: function(err) {
                console.error("Token 同步失敗", err);
            }
        });
    }
})();
