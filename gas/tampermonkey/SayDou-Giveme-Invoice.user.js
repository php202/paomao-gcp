// ==UserScript==
// @name         SayDou 結帳同步 Giveme 發票
// @namespace    http://tampermonkey.net/
// @version      2026.3.30
// @description  Saydou 結帳成功或修改結帳時跳出發票綁定視窗，開立 Giveme 電子發票（可連動印表機）
// @author       You
// @match        *://m.saydou.com/*
// @match        *://saywebdatafeed.saydou.com/*
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/php202/paomao-gcp/master/gas/tampermonkey/SayDou-Giveme-Invoice.user.js
// @downloadURL  https://raw.githubusercontent.com/php202/paomao-gcp/master/gas/tampermonkey/SayDou-Giveme-Invoice.user.js
// ==/UserScript==

(function() {
    'use strict';

    // 請改成你的 GCP Cloud Run 網址（與 set-env.sh REPORT_API_BASE 同服務、不含路徑）
    const GCP_BASE = "https://gcp.paopaomao.tw";

    /**
     * 攔截 checkout 相關 API，觸發開發票視窗
     * - checkout/add: 新結帳 → response.order 有完整訂單
     * - management/checkout/update: 修改結帳 → response 可能沒有 order，需從 request body 補
     */
    const CHECKOUT_RE = /checkout\/add|management\/checkout/;
    const UPDATE_RE   = /checkout\/update/;

    /**
     * checkout/update request body → checkout/add response.order 格式轉換
     * update body: items[], cashPay, creditCard, linePay, ordcid, storid, membid...
     * add response: ordds[], cash, card, rprice, ordrsn, storid...
     */
    function normalizeUpdateBody(raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!data || !data.storid) return null;

        // items → ordds
        const ordds = (data.items || []).map(item => ({
            godnam: item.godnam || '',
            rprice: item.price_ || 0,
            price_: item.price_ || 0,
            amount: item.amount || 1,
        }));

        // 總價 = items 的 price_ × amount 總和
        const rprice = ordds.reduce((sum, d) => sum + (d.rprice * (d.amount || 1)), 0);

        // 付款方式映射
        const card = Number(data.creditCard || 0);
        const cash = Number(data.cashPay || 0);
        const linepay = Number(data.linePay || 0);

        return {
            storid: data.storid,
            ordcid: data.ordcid || '',
            ordrsn: data.ordcid || '',   // update 沒有 ordrsn，用 ordcid
            membid: data.membid || '',
            rprice: rprice,
            price_: rprice,
            ordds: ordds,
            cash: cash,
            card: card,
            linepay: linepay,
            creditcard: card,
            voucher: Number(data.voucher || 0),
            // update body 沒有 memnam/phone_，Modal 會顯示空白，可手動輸入
            memnam: '',
            phone_: '',
        };
    }

    function tryOpenInvoiceFromResponse(text, requestBody, url) {
        try {
            const json = JSON.parse(text);
            if (!json || json.status !== true) return;

            let order = json.order;

            // checkout/update：response 沒有完整 order，從 request body 轉換
            if (!order && UPDATE_RE.test(url || '')) {
                try {
                    order = normalizeUpdateBody(requestBody);
                } catch (_) {}
            }

            if (!order) return;
            const storid = order.storid != null ? String(order.storid).trim() : '';
            if (!storid) return;

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

        if (CHECKOUT_RE.test(url)) {
            try {
                const clone = res.clone();
                const text = await clone.text();
                // 取 request body 給 update 用
                const reqBody = config?.body || null;
                tryOpenInvoiceFromResponse(text, reqBody, url);
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
        if (CHECKOUT_RE.test(url)) {
            this._reqBody = body; // 存下 request body
            this.addEventListener('load', function() {
                if (this.responseText) tryOpenInvoiceFromResponse(this.responseText, this._reqBody, url);
            });
        }
        return origSend.apply(this, arguments);
    };

    /** 發票圖：開新分頁顯示並自動帶出列印視窗，僅列印發票本體（去頭尾留白、請關閉頁首頁尾） */
    function openInvoicePrintTab(title, base64, contentType, printUrl, searchInvoiceUrl) {
        const mime = (contentType && contentType.split(';')[0].trim()) || 'image/png';
        const dataUrl = 'data:' + mime + ';base64,' + base64;
        const w = window.open('', '_blank');
        if (!w) {
            if (printUrl) window.open(printUrl, '_blank');
            alert('開單成功！請允許彈出視窗以列印發票，或至 Giveme 發票查詢列印。');
            return;
        }
        w.document.write(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || '發票列印').replace(/</g, '&lt;') + '</title>' +
            '<style>@page{margin:0;size:80mm auto;}body{margin:0;padding:0;background:#fff;}@media print{body{margin:0;padding:0;}.print-hide{display:none!important;}img{display:block;margin:0 auto;max-width:100%;height:auto;}}</style></head>' +
            '<body>' +
            '<div class="print-hide" style="margin:8px;font-size:12px;color:#333;line-height:1.6;">' +
            '<p style="margin:0 0 6px 0;font-weight:bold;">感熱紙列印設定：</p>' +
            '<ul style="margin:0;padding-left:18px;">' +
            '<li>展開「更多設定」→ 邊界選 <b>無</b></li>' +
            '<li>紙張大小：58mm 感熱紙（如 58×3276mm）</li>' +
            '<li>縮放：預設或 100%</li>' +
            '<li><b>請勿勾選</b>「頁首及頁尾」「背景圖形」</li>' +
            '</ul>' +
            '<p style="margin:6px 0 0;color:#666;">預覽若未顯示發票可點「符合視窗寬度」後再列印。</p></div>' +
            '<img src="' + dataUrl.replace(/"/g, '&quot;') + '" alt="發票" onload="window.focus();window.print();">' +
            '</body></html>'
        );
        w.document.close();
    }

    function openInvoiceModal(order) {
        if (document.getElementById('saydou-giveme-modal')) return;

        const overlay = document.createElement('div');
        overlay.id = 'saydou-giveme-modal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:8px;padding:40px;min-width:640px;max-width:90vw;box-shadow:0 4px 20px rgba(0,0,0,.2);';
        box.innerHTML = `
            <h3 style="margin:0 0 12px 0;font-size:16px;">開立電子發票</h3>
            <p style="margin:0 0 12px;color:#666;font-size:13px;">單號 ${(order.ordrsn || order.ordcid || '').slice(0, 20)} 訂單總額 $${order.rprice ?? order.price_ ?? 0}</p>
            <div style="margin-bottom:12px;">
                <label>發票金額（實際收款，選填）<input type="number" id="giveme-invoiceAmount" placeholder="與訂單總額相同則留空" min="1" step="1" style="margin-left:6px;width:100px;"></label>
                <span style="color:#888;font-size:12px;">若部分為優惠券／儲值等，請填實際開立金額（例 520）</span>
            </div>
            <div style="margin-bottom:12px;">
                <label><input type="radio" name="invType" value="B2C" checked> B2C 一般</label>
                <label style="margin-left:12px;"><input type="radio" name="invType" value="B2B"> B2B 統編</label>
            </div>
            <div id="giveme-b2c" style="margin-bottom:12px;">
                <div><label>條碼載具（選填，有則不列印）<input type="text" id="giveme-phone" placeholder="/1234567" style="margin-left:6px;width:120px;"></label></div>
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
            const invoiceAmountVal = (box.querySelector('#giveme-invoiceAmount').value || '').trim();
            if (invoiceAmountVal) {
                const n = parseInt(invoiceAmountVal, 10);
                if (!isNaN(n) && n >= 1) options.invoiceAmount = n;
            }
            if (isB2B) {
                options.companyTaxId = (box.querySelector('#giveme-companyTaxId').value || '').trim();
                if (!options.companyTaxId) {
                    alert('B2B 請填寫買方統編');
                    return;
                }
            } else {
                options.phone = (box.querySelector('#giveme-phone').value || '').trim();
            }

            const btn = box.querySelector('#giveme-submit');
            btn.disabled = true;
            btn.textContent = '開單中...';

            let responded = false;
            function resetButton() {
                if (responded) return;
                responded = true;
                btn.disabled = false;
                btn.textContent = '確認開單';
            }
            const SAFETY_MS = 50000;
            const safetyTimer = setTimeout(function() {
                if (responded) return;
                resetButton();
                alert('請求逾時，請稍後再試或手動至 Giveme 查詢發票。');
            }, SAFETY_MS);

            GM_xmlhttpRequest({
                method: 'POST',
                url: GCP_BASE + '/giveme-invoice',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ order, options }),
                timeout: 45000,
                onload: function(r) {
                    clearTimeout(safetyTimer);
                    if (responded) return;
                    responded = true;
                    overlay.remove();
                    try {
                        const j = JSON.parse(r.responseText);
                        const ok = j.success === true || String(j.success).toLowerCase() === 'true';
                        if (ok) {
                            const code = j.code || '';
                            const searchInvoiceUrl = j.searchInvoiceUrl || '';
                            const printUrl = j.printUrl || (j.code && j.uncode ? (GCP_BASE + '/giveme-invoice-print?code=' + encodeURIComponent(j.code) + '&uncode=' + encodeURIComponent(j.uncode)) : '');
                            if (j.printImageBase64) {
                                openInvoicePrintTab('開單成功！發票號碼：' + code, j.printImageBase64, j.printImageContentType || 'image/png', printUrl, searchInvoiceUrl);
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
                        resetButton();
                        alert('開單失敗：' + (r.responseText?.slice(0, 150) || '網路錯誤'));
                    }
                },
                onerror: function() {
                    clearTimeout(safetyTimer);
                    resetButton();
                    alert('連線失敗，請檢查 GCP 網址與網路');
                },
                ontimeout: function() {
                    clearTimeout(safetyTimer);
                    resetButton();
                    alert('請求逾時（超過 45 秒），請稍後再試或至 Giveme 查詢發票。');
                }
            });
        });
    }

    console.log('SayDou Giveme 發票同步已啟動，結帳成功後會跳出開單視窗');
})();
