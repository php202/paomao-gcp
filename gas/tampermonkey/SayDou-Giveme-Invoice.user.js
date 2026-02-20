// ==UserScript==
// @name         SayDou 結帳同步 Giveme 發票
// @namespace    http://tampermonkey.net/
// @version      2026-02-20
// @description  Saydou 結帳成功時跳出發票綁定視窗，開立 Giveme 電子發票（可連動印表機）
// @author       You
// @match        *://m.saydou.com/*
// @match        *://saywebdatafeed.saydou.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // 請改成你的 GCP Cloud Run 網址（與 SayDou Token Sync 同服務）
    const GCP_BASE = "https://pao-checkin-api-254258679209.asia-east1.run.app";

    function tryOpenInvoiceFromResponse(text) {
        try {
            const json = JSON.parse(text);
            if (!json || json.status !== true || !json.order) return;
            const order = json.order;
            const storid = order.storid != null ? String(order.storid).trim() : '';
            GM_xmlhttpRequest({
                method: 'GET',
                url: GCP_BASE + '/giveme-invoice/check?storid=' + encodeURIComponent(storid),
                timeout: 8000,
                onload: function(r) {
                    try {
                        const j = JSON.parse(r.responseText);
                        if (j && j.configured === true) {
                            setTimeout(() => openInvoiceModal(order), 100);
                        }
                    } catch (_) {}
                },
                onerror: function() {}
            });
        } catch (_) {}
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const [resource, config] = args;
        const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        const res = await originalFetch.apply(this, args);

        if (/checkout\/add|management\/checkout/.test(url)) {
            try {
                const clone = res.clone();
                const text = await clone.text();
                tryOpenInvoiceFromResponse(text);
            } catch (_) {}
        }
        return res;
    };

    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function(method, url) {
        this._url = url;
        return origOpen.apply(this, arguments);
    };
    XHR.send = function(body) {
        const url = this._url || '';
        if (/checkout\/add|management\/checkout/.test(url)) {
            this.addEventListener('load', function() {
                if (this.responseText) tryOpenInvoiceFromResponse(this.responseText);
            });
        }
        return origSend.apply(this, arguments);
    };

    function showPrintModal(title, base64, contentType, printUrl, searchInvoiceUrl) {
        const overlay = document.createElement('div');
        overlay.id = 'saydou-giveme-print-modal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:8px;padding:16px;max-width:95vw;max-height:90vh;overflow:auto;box-shadow:0 4px 20px rgba(0,0,0,.2);';
        const mime = (contentType && contentType.split(';')[0].trim()) || 'image/png';
        const dataUrl = 'data:' + mime + ';base64,' + base64;
        const searchLink = searchInvoiceUrl ? '<a href="' + searchInvoiceUrl + '" target="_blank" rel="noopener" style="margin-right:8px;">Giveme 發票查詢</a>' : '';
        box.innerHTML = `
            <h3 style="margin:0 0 12px 0;font-size:16px;">${title}</h3>
            <div id="giveme-img-wrap" style="margin:0 auto 12px;">
                <img src="${dataUrl}" alt="發票" style="max-width:100%;height:auto;display:block;">
            </div>
            <p id="giveme-img-fail" style="display:none;color:#c00;font-size:13px;">圖片無法顯示，請點下方「Giveme 發票查詢」或「在新分頁開啟」列印。</p>
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                <button type="button" id="giveme-print-btn">列印</button>
                ${searchLink}
                ${printUrl ? '<a href="' + printUrl + '" target="_blank" rel="noopener" style="margin-right:8px;">在新分頁開啟</a>' : ''}
                <button type="button" id="giveme-close-print">關閉</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const img = box.querySelector('img');
        const failMsg = box.querySelector('#giveme-img-fail');
        img.onerror = function() {
            img.style.display = 'none';
            if (failMsg) failMsg.style.display = 'block';
        };
        box.querySelector('#giveme-close-print').addEventListener('click', () => overlay.remove());
        box.querySelector('#giveme-print-btn').addEventListener('click', () => {
            if (searchInvoiceUrl) {
                window.open(searchInvoiceUrl, '_blank');
                return;
            }
            if (printUrl) {
                window.open(printUrl, '_blank');
                return;
            }
            const w = window.open('', '_blank');
            if (w) {
                w.document.write('<html><head><title>發票列印</title></head><body style="margin:0;"><img src="' + dataUrl + '" style="max-width:100%;"/></body></html>');
                w.document.close();
                const wi = w.document.body.querySelector('img');
                if (wi) wi.onload = () => { w.focus(); w.print(); };
                else { w.focus(); w.print(); }
            }
        });
    }

    function openInvoiceModal(order) {
        if (document.getElementById('saydou-giveme-modal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'saydou-giveme-modal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:8px;padding:20px;min-width:320px;max-width:90vw;box-shadow:0 4px 20px rgba(0,0,0,.2);';
        box.innerHTML = `
            <h3 style="margin:0 0 12px 0;font-size:16px;">開立電子發票</h3>
            <p style="margin:0 0 12px;color:#666;font-size:13px;">單號 ${(order.ordrsn || order.ordcid || '').slice(0, 20)} 金額 $${order.rprice ?? order.price_ ?? 0}</p>
            <div style="margin-bottom:12px;">
                <label><input type="radio" name="invType" value="B2C" checked> B2C 一般</label>
                <label style="margin-left:12px;"><input type="radio" name="invType" value="B2B"> B2B 統編</label>
            </div>
            <div id="giveme-b2c" style="margin-bottom:12px;">
                <div style="margin-bottom:6px;"><label>手機條碼（選填，有則不列印）<input type="text" id="giveme-phone" placeholder="/1234567" style="margin-left:6px;width:120px;"></label></div>
                <div><label>編號載具（選填）<input type="text" id="giveme-orderCode" placeholder="會員載具" style="margin-left:6px;width:140px;"></label></div>
            </div>
            <div id="giveme-b2b" style="display:none;margin-bottom:12px;">
                <label>買方統編（必填）<input type="text" id="giveme-companyTaxId" style="margin-left:6px;width:120px;"></label>
            </div>
            <p style="margin:12px 0 0;color:#888;font-size:12px;">按「取消」則本筆不開立電子發票。</p>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                <button type="button" id="giveme-cancel">取消（不開立發票）</button>
                <button type="button" id="giveme-submit">確認開單</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const typeRadios = box.querySelectorAll('input[name="invType"]');
        const b2cDiv = box.querySelector('#giveme-b2c');
        const b2bDiv = box.querySelector('#giveme-b2b');
        typeRadios.forEach(r => {
            r.addEventListener('change', () => {
                const isB2B = box.querySelector('input[name="invType"]:checked').value === 'B2B';
                b2cDiv.style.display = isB2B ? 'none' : 'block';
                b2bDiv.style.display = isB2B ? 'block' : 'none';
            });
        });

        box.querySelector('#giveme-cancel').addEventListener('click', () => overlay.remove());
        box.querySelector('#giveme-submit').addEventListener('click', () => {
            const isB2B = box.querySelector('input[name="invType"]:checked').value === 'B2B';
            const options = { type: isB2B ? 'B2B' : 'B2C' };
            if (isB2B) {
                options.companyTaxId = (box.querySelector('#giveme-companyTaxId').value || '').trim();
                if (!options.companyTaxId) {
                    alert('B2B 請填寫買方統編');
                    return;
                }
            } else {
                options.phone = (box.querySelector('#giveme-phone').value || '').trim();
                options.orderCode = (box.querySelector('#giveme-orderCode').value || '').trim() || undefined;
            }

            const btn = box.querySelector('#giveme-submit');
            btn.disabled = true;
            btn.textContent = '開單中...';

            GM_xmlhttpRequest({
                method: 'POST',
                url: GCP_BASE + '/giveme-invoice',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ order, options }),
                timeout: 30000,
                onload: function(r) {
                    overlay.remove();
                    try {
                        const j = JSON.parse(r.responseText);
                        const ok = j.success === true || String(j.success).toLowerCase() === 'true';
                        if (ok) {
                            const code = j.code || '';
                            const searchInvoiceUrl = j.searchInvoiceUrl || '';
                            const printUrl = j.printUrl || (j.code && j.uncode ? (GCP_BASE + '/giveme-invoice-print?code=' + encodeURIComponent(j.code) + '&uncode=' + encodeURIComponent(j.uncode)) : '');
                            if (j.printImageBase64) {
                                showPrintModal('開單成功！發票號碼：' + code, j.printImageBase64, j.printImageContentType || 'image/png', printUrl, searchInvoiceUrl);
                            } else {
                                const openUrl = searchInvoiceUrl || printUrl;
                                if (openUrl) window.open(openUrl, '_blank');
                                const msg = '開單成功！發票號碼：' + code + (openUrl ? '\n\n已為您開啟' + (searchInvoiceUrl ? ' Giveme 發票查詢頁（可列印／轉 PDF）' : '列印頁面') + '。' : '');
                                alert(msg);
                            }
                        } else {
                            alert('開單失敗：' + (j.msg || r.responseText?.slice(0, 100) || ''));
                        }
                    } catch {
                        alert('開單失敗：' + (r.responseText?.slice(0, 150) || '網路錯誤'));
                    }
                },
                onerror: function() {
                    btn.disabled = false;
                    btn.textContent = '確認開單';
                    alert('連線失敗，請檢查 GCP 網址與網路');
                }
            });
        });
    }

    console.log('SayDou Giveme 發票同步已啟動，結帳成功後會跳出開單視窗');
})();
