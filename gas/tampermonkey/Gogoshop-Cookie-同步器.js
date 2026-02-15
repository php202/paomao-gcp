// ==UserScript==
// @name         Gogoshop Cookie 同步器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  一鍵將 Gogoshop Cookie 同步到 Google Apps Script
// @author       You
// @match        https://my.gogoshop.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @updateURL    https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/Gogoshop-Cookie-同步器.js
// @downloadURL https://raw.githubusercontent.com/php202/paomao/gas-only/node_express/gas/tampermonkey/Gogoshop-Cookie-同步器.js
// ==/UserScript==

(function() {
    'use strict';

    // === 設定區 ===
    // 請填入你的 GAS Web App 網址
    const GAS_URL = "https://script.google.com/macros/s/AKfycbylWApG-4rne8crGM8CxfN_BIjNvZt4U9KU6RNigzj7ploTEm84p2JmZwLTMFlLMQBp/exec";

    // === 建立按鈕 ===
    function createSyncButton() {
        const btn = document.createElement('button');
        btn.innerHTML = "🔄 同步 Cookie 到 GAS";
        btn.style.position = "fixed";
        btn.style.bottom = "20px";
        btn.style.right = "20px";
        btn.style.zIndex = "9999";
        btn.style.padding = "10px 20px";
        btn.style.backgroundColor = "#28a745";
        btn.style.color = "white";
        btn.style.border = "none";
        btn.style.borderRadius = "5px";
        btn.style.cursor = "pointer";
        btn.style.boxShadow = "0 2px 5px rgba(0,0,0,0.3)";
        btn.style.fontWeight = "bold";

        btn.onclick = sendCookieToGAS;
        document.body.appendChild(btn);
    }

    // === 發送 Cookie 的函式 ===
    function sendCookieToGAS() {
        const currentCookie = document.cookie;

        if (!currentCookie) {
            alert("❌ 抓不到 Cookie，請確認你已登入。");
            return;
        }

        const btn = this; // 按鈕本身
        btn.innerHTML = "⏳ 傳送中...";
        btn.disabled = true;
        btn.style.backgroundColor = "#6c757d";

        // 使用 GM_xmlhttpRequest 避開跨域 (CORS) 問題
        GM_xmlhttpRequest({
            method: "POST",
            url: GAS_URL,
            headers: {
                "Content-Type": "application/json"
            },
            data: JSON.stringify({ cookie: currentCookie }),
            onload: function(response) {
                if (response.status === 200) {
                    alert("✅ Cookie 同步成功！GAS 報表現在可以使用最新憑證了。");
                    btn.innerHTML = "🔄 同步 Cookie 到 GAS";
                    btn.style.backgroundColor = "#28a745";
                } else {
                    alert("❌ 同步失敗，GAS 回傳錯誤：" + response.responseText);
                    btn.innerHTML = "⚠️ 重試";
                    btn.style.backgroundColor = "#dc3545";
                }
                btn.disabled = false;
            },
            onerror: function(err) {
                alert("❌ 請求發送失敗，請檢查網路或網址。");
                console.error(err);
                btn.innerHTML = "⚠️ 重試";
                btn.disabled = false;
            }
        });
    }

    // 等待頁面載入後產生按鈕
    window.addEventListener('load', () => {
        // 延遲 1 秒確保頁面介面載入完畢
        setTimeout(createSyncButton, 1000);
    });

})();