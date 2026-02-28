// ▼▼▼ API endpoint (GCP local server) ▼▼▼
const GAS_API_URL = "https://gcp.paopaomao.tw/stores";

/** 未處理訊息超過此數量即顯示紅字「客人正在看著你」 */
const UNREAD_WARNING_THRESHOLD = 5;

/** 常用文字預設內容（可自行修改，會存到 chrome.storage） */
const DEFAULT_QUICK_REPLY = `🔸近期人氣No.1 👉 活氧泡泡課程 🔸
結合「小氣泡＋水光肌」再升級，添加【舒敏凍晶粉】
✨保濕力更UP、活性最強✨
`;

let currentBotId = null;

/**
 * @param {number} unprocessedCount - 未處理總筆數
 * @param {number} [visibleCount] - 篩選後可見筆數；若有且與總數不同則顯示「未處理 N 則（顯示 M 則）」避免搜尋導致列表空白卻仍顯示 69 則
 */
function updateMsgStatus(unprocessedCount, visibleCount) {
  const el = document.getElementById('msg-status');
  if (!el) return;
  el.classList.remove('msg-status--danger', 'msg-status--success', 'msg-status--neutral');
  const showVisible = visibleCount !== undefined && visibleCount !== unprocessedCount;
  const suffix = showVisible ? `（顯示 ${visibleCount} 則）` : '';
  if (unprocessedCount === 0) {
    el.style.display = 'block';
    el.className = 'msg-status msg-status--success';
    el.textContent = '✓ 客人很高興 · 大家都覺得你很棒！';
  } else if (unprocessedCount >= UNREAD_WARNING_THRESHOLD) {
    el.style.display = 'block';
    el.className = 'msg-status msg-status--danger';
    el.textContent = `未處理 ${unprocessedCount} 則 · 客人正在看著你${suffix}`;
  } else {
    el.style.display = 'block';
    el.className = 'msg-status msg-status--neutral';
    el.textContent = `未處理的訊息：${unprocessedCount} 則${suffix}`;
  }
}

function hideMsgStatus() {
  const el = document.getElementById('msg-status');
  if (el) el.style.display = 'none';
}

/** 是否為需優先處理的訊息：含時間格式（6:00、1930、0800、8.00、8點）或關鍵字（預約、有嗎、呼叫、位、候補） */
function isPriorityMsg(msg) {
  const s = String(msg || '').trim();
  if (!s) return false;
  if (/預約|有嗎|呼叫|位|候補/.test(s)) return true;
  if (/\d{1,2}:\d{2}/.test(s)) return true;   // 6:00, 12:30
  if (/\b(0?[0-9]|1[0-9]|2[0-3])[0-5][0-9]\b/.test(s)) return true; // 0800, 1930
  if (/\d{1,2}\.\d{2}/.test(s)) return true; // 8.00
  if (/\d{1,2}點/.test(s)) return true;      // 8點
  return false;
} 

async function refreshData() {
  const storeNameDiv = document.getElementById('store-name');
  const listDiv = document.getElementById('msg-list');
  const loadingDiv = document.getElementById('loading');
  
  // 1. 自動填入名字
  const inputOp = document.getElementById('operator_name');
  if (inputOp) {
    chrome.storage.local.get('operator_name', (result) => {
      if (result.operator_name) inputOp.value = result.operator_name;
    });
    inputOp.addEventListener('change', () => {
      chrome.storage.local.set({ 'operator_name': inputOp.value.trim() });
    });
  }

  // 2. 自動填入預約表單的日期為今天 (預設)
  const inputDate = document.getElementById('bk-date');
  if (inputDate && !inputDate.value) {
    const today = new Date();
    const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().split('T')[0];
    inputDate.value = localDate;
  }

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab || !tab.url || !tab.url.includes("chat.line.biz")) {
    loadingDiv.style.display = 'none';
    storeNameDiv.textContent = "非 LINE 後台";
    listDiv.innerHTML = '<div style="padding:10px; color:#999; text-align:center;">請切換到 LINE OA 後台</div>';
    document.querySelector('.availability-section').style.display = 'none';
    document.querySelector('.booking-section').style.display = 'none';
    document.querySelector('.quick-reply-section').style.display = 'none';
    document.querySelector('.search-box').style.display = 'none';
    var wlSection = document.getElementById('waitlist-section');
    if (wlSection) wlSection.style.display = 'none';
    hideMsgStatus();
    return;
  }

  document.querySelector('.availability-section').style.display = 'block';
  document.querySelector('.booking-section').style.display = 'block';
  document.querySelector('.quick-reply-section').style.display = 'block';
  document.querySelector('.search-box').style.display = 'block';

  const match = tab.url.match(/chat\.line\.biz\/(U[a-f0-9]{32})/);
  const newBotId = match ? match[1] : null;

  if (!newBotId) {
    storeNameDiv.textContent = "無法讀取 Bot ID";
    return;
  }

  currentBotId = newBotId; 
  storeNameDiv.textContent = `Bot ID: ${newBotId} (讀取中...)`;
  listDiv.innerHTML = '';
  loadingDiv.style.display = 'block';

  fetchMsgList(newBotId);
}

async function fetchMsgList(botId) {
  const storeNameDiv = document.getElementById('store-name');
  const listDiv = document.getElementById('msg-list');
  const loadingDiv = document.getElementById('loading');

  try {
    const timestamp = new Date().getTime();
    const response = await fetch(`${GAS_API_URL}?action=getList&botId=${botId}&_t=${timestamp}`);
    const data = await response.json();

    loadingDiv.style.display = 'none';

    if (data.error) {
      storeNameDiv.textContent = `無法識別店家`;
      listDiv.innerHTML = `<div style="text-align:center;color:red;">${data.error}</div>`;
      hideMsgStatus();
      return;
    }

    storeNameDiv.textContent = `店家: ${data.storeName || ''}`;
    storeNameDiv.style.color = "#00B900";
    storeNameDiv.style.fontWeight = "bold";

    var wlSection = document.getElementById('waitlist-section');
    if (wlSection) wlSection.style.display = 'block';
    fetchWaitlist(botId);

    const list = (data && Array.isArray(data.data)) ? data.data : [];
    if (list.length === 0) {
      listDiv.innerHTML = '<div style="text-align:center;color:#999;margin-top:20px;">🎉 目前沒有未處理訊息</div>';
      updateMsgStatus(0);
      return;
    }

    const seen = new Set();
    const uniqueData = list.filter(item => {
      const key = `${item.time}_${item.name}_${item.msg}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 優先處理：含時間格式（6:00、1930、0800、8.00、8點）或關鍵字（預約、有嗎、呼叫、位）排最上面
    uniqueData.sort((a, b) => {
      const pa = isPriorityMsg(a.msg);
      const pb = isPriorityMsg(b.msg);
      if (pa && !pb) return -1;
      if (!pa && pb) return 1;
      return 0;
    });

    updateMsgStatus(uniqueData.length);

    uniqueData.forEach(item => {
      const div = document.createElement('div');
      div.className = 'msg-item';
      div.setAttribute('data-search', (item.name + item.msg).toLowerCase());
      const hasReplyToken = !!(item.replyToken && item.replyToken.trim());
      const replyTokenEsc = (item.replyToken || '').replace(/"/g, '&quot;');
      const replyPlaceholder = hasReplyToken ? '回覆此則（不佔 Push）' : '回覆此則（無 token 時請改用手動傳送）';
      const memberBadge = item.memberPhone
        ? `<span class="member-badge" title="會員: ${(item.memberName||'').replace(/"/g,'&quot;')} / ${item.memberPhone}">📱 ${item.memberPhone}</span>`
        : (item.userId ? `<span class="member-badge member-unknown" style="cursor:pointer" title="點擊請客戶輸入手機" data-reply-token="${replyTokenEsc}" data-user-id="${item.userId}">❓ 未配對</span>` : '');
      div.innerHTML = `
        <div class="msg-header">
          <span>${item.time}</span>
          <span style="margin:0 5px; color:#ddd;">|</span>
          <span class="msg-name" title="點擊複製">${item.name}</span>
          ${memberBadge}
          <button class="btn-copy-name" title="用此名字篩選訊息">🔍</button>
        </div>
        <div class="msg-content">${item.msg}</div>
        <div class="msg-reply-row">
          <input type="text" class="msg-reply-input" placeholder="${replyPlaceholder}" data-reply-token="${replyTokenEsc}">
          <button type="button" class="btn-reply-msg" data-reply-token="${replyTokenEsc}">回覆</button>
        </div>
        <button class="btn-done" data-row="${item.row}">✔ 完成</button>
        <button class="btn-waitlist" data-user-id="${item.userId || ''}" data-name="${(item.name || '').replace(/"/g, '&quot;')}">排候補</button>
      `;
      listDiv.appendChild(div);

      const nameSpan = div.querySelector('.msg-name');
      nameSpan.addEventListener('click', () => {
        navigator.clipboard.writeText(item.name).then(() => {
          nameSpan.textContent = "已複製，請搜尋";
          nameSpan.style.color = "#00B900";
          setTimeout(() => { nameSpan.textContent = item.name; nameSpan.style.color = "#0066cc"; }, 1500);
        });
      });

      // ❓ 未配對：點擊後彈出輸入框讓員工輸入手機號碼查會員
      const unknownBadge = div.querySelector('.member-unknown');
      if (unknownBadge) {
        unknownBadge.addEventListener('click', async (e) => {
          e.stopPropagation();
          const phone = prompt('請輸入此客人的手機號碼：');
          if (!phone || phone.trim().length < 10) return;
          const cleanPhone = phone.trim().replace(/[-\s]/g, '');
          unknownBadge.textContent = '🔍 查詢中...';
          try {
            const resp = await fetch(`${GAS_API_URL}?action=checkMember&botId=${currentBotId}&phone=${cleanPhone}`);
            const data = await resp.json();
            if (data.status === 'success' && data.name) {
              unknownBadge.textContent = `📱 ${cleanPhone}`;
              unknownBadge.className = 'member-badge';
              unknownBadge.title = `會員: ${data.name} / ${cleanPhone}`;
              alert(`✅ 已配對會員：${data.name}（${cleanPhone}）`);
            } else {
              unknownBadge.textContent = '❓ 未配對';
              alert(`查無此會員（${cleanPhone}），請確認號碼是否正確`);
            }
          } catch (err) {
            unknownBadge.textContent = '❓ 未配對';
            alert('查詢失敗：' + err.message);
          }
        });
      }

      // 放大鏡：將名字填入搜尋框並觸發過濾
      div.querySelector('.btn-copy-name').addEventListener('click', (e) => {
        e.stopPropagation();
        const searchInput = document.getElementById('input-search');
        if (searchInput) {
          searchInput.value = item.name;
          // 觸發 input 事件，沿用既有的過濾邏輯
          const ev = new Event('input', { bubbles: true });
          searchInput.dispatchEvent(ev);
          searchInput.focus();
        }
      });

      div.querySelector('.btn-done').addEventListener('click', async (e) => {
        const operatorName = document.getElementById('operator_name').value.trim();
        if (!operatorName) {
          alert("⚠️ 請先在上方輸入您的名字！");
          document.getElementById('operator_name').focus();
          return;
        }
        
        const row = e.target.getAttribute('data-row');
        const card = e.target.parentElement;
        card.style.opacity = '0.4';
        e.target.textContent = '處理中...';

        try {
          await fetch(`${GAS_API_URL}?action=delete&row=${row}&operator_name=${encodeURIComponent(operatorName)}`);
          card.remove();
          const remaining = listDiv.querySelectorAll('.msg-item').length;
          updateMsgStatus(remaining);
          if (remaining === 0) listDiv.innerHTML = '<div style="text-align:center;color:#999;margin-top:20px;">全部處理完畢！</div>';
        } catch (err) {
          alert('連線失敗');
          card.style.opacity = '1';
          e.target.textContent = '✔ 完成';
        }
      });

      var btnWaitlist = div.querySelector('.btn-waitlist');
      if (btnWaitlist) {
        btnWaitlist.addEventListener('click', () => {
          var userId = btnWaitlist.getAttribute('data-user-id') || '';
          var name = (btnWaitlist.getAttribute('data-name') || '').replace(/&quot;/g, '"');
          if (!userId) { alert('此則訊息無 userId'); return; }
          openWaitlistModal(userId, name);
        });
      }

      var replyInput = div.querySelector('.msg-reply-input');
      var btnReply = div.querySelector('.btn-reply-msg');
      if (btnReply && replyInput && botId) {
        btnReply.addEventListener('click', async () => {
          var text = (replyInput.value || '').trim();
          if (!text) { alert('請輸入回覆內容'); replyInput.focus(); return; }
          var rt = (replyInput.getAttribute('data-reply-token') || '').replace(/&quot;/g, '"');
          btnReply.disabled = true;
          btnReply.textContent = '送出中...';
          try {
            var url = GAS_API_URL + '?action=replyMessage&botId=' + encodeURIComponent(botId) + '&replyToken=' + encodeURIComponent(rt) + '&text=' + encodeURIComponent(text);
            var resp = await fetch(url);
            var data = await resp.json();
            if (data.status === 'success') {
              replyInput.value = '';
              replyInput.disabled = true;
              btnReply.disabled = true;
              var operatorName = getOperatorName();
              var row = div.querySelector('.btn-done') ? div.querySelector('.btn-done').getAttribute('data-row') : '';
              if (row && operatorName) {
                try {
                  await fetch(GAS_API_URL + '?action=delete&row=' + encodeURIComponent(row) + '&operator_name=' + encodeURIComponent(operatorName));
                  div.remove();
                  var remaining = listDiv.querySelectorAll('.msg-item').length;
                  updateMsgStatus(remaining);
                  if (remaining === 0) listDiv.innerHTML = '<div style="text-align:center;color:#999;margin-top:20px;">全部處理完畢！</div>';
                } catch (delErr) {}
              }
              btnReply.textContent = '已回覆';
              btnReply.style.color = '#00B900';
            } else {
              var errMsg = data.message || '回覆失敗';
              alert(errMsg + '\n\n若為 token 已過期，請改用手動傳送（在 LINE 後台直接回覆或使用 Push）。');
              btnReply.disabled = false;
              btnReply.textContent = '回覆';
            }
          } catch (err) {
            alert('連線失敗');
            btnReply.disabled = false;
            btnReply.textContent = '回覆';
          }
        });
      }
    });

  } catch (err) { loadingDiv.style.display = 'none'; }
}

/** 候補清單：取得並渲染 */
async function fetchWaitlist(botId) {
  var listEl = document.getElementById('waitlist-list');
  if (!listEl) return;
  if (!botId) { listEl.innerHTML = ''; return; }
  try {
    var resp = await fetch(`${GAS_API_URL}?action=getWaitlist&botId=${encodeURIComponent(botId)}&_t=${Date.now()}`);
    var data = await resp.json();
    if (data.status !== 'success' || !Array.isArray(data.data)) {
      listEl.innerHTML = '<div style="color:#999; font-size:12px;">尚無候補或載入失敗</div>';
      return;
    }
    var list = data.data;
    if (list.length === 0) {
      listEl.innerHTML = '<div style="color:#999; font-size:12px;">目前沒有待追蹤的候補</div>';
      return;
    }
    listEl.innerHTML = '';
    list.forEach(function (item) {
      var displayDate = item.displayDate || (item.date != null ? String(item.date) : '');
      var displayName = item.displayName || (item.userId ? String(item.userId).slice(0, 12) + '…' : '');
      var handler = item.handler ? String(item.handler).trim() : '';
      var remark = item.remark ? String(item.remark).trim() : '';
      var peopleVal = (item.people != null && item.people >= 1) ? item.people : 1;
      var peopleLabel = peopleVal > 1 ? ' · ' + peopleVal + '人' : '';
      var nameEscaped = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      var remarkEscaped = remark ? remark.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
      var slotLabel = item.slotAvailable === true ? ' · <span class="waitlist-slot-ok">有空位</span>' : (item.slotAvailable === false ? ' · <span class="waitlist-slot-full">仍滿位</span>' : '');
      var metaHtml = displayDate + peopleLabel + ' · <span class="waitlist-name" title="點擊複製">' + nameEscaped + '</span>' + (handler ? ' · 處理人：' + handler.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '') + (remarkEscaped ? ' · 備註：' + remarkEscaped : '') + slotLabel;
      var div = document.createElement('div');
      div.className = 'waitlist-item';
      div.innerHTML = '<div class="row-meta waitlist-meta-copy">' + metaHtml + '</div>' +
        '<div class="row-btns">' +
        '<button type="button" class="btn-push" data-row-index="' + (item.rowIndex || '') + '">滿位，傳提醒</button>' +
        '<button type="button" class="btn-done-wl" data-row-index="' + (item.rowIndex || '') + '">已完成預約</button>' +
        '<button type="button" class="btn-handled" data-row-index="' + (item.rowIndex || '') + '">已處理</button>' +
        '</div>';
      var nameSpan = div.querySelector('.waitlist-name');
      if (nameSpan) {
        nameSpan.addEventListener('click', function () {
          navigator.clipboard.writeText(displayName).then(function () {
            var orig = nameSpan.textContent;
            nameSpan.textContent = '已複製';
            nameSpan.style.color = '#00B900';
            setTimeout(function () { nameSpan.textContent = orig; nameSpan.style.color = ''; }, 800);
          });
        });
      }
      var btnPush = div.querySelector('.btn-push');
      var btnDoneWl = div.querySelector('.btn-done-wl');
      var btnHandled = div.querySelector('.btn-handled');
      if (btnPush) btnPush.addEventListener('click', function () { doMarkWaitlistPushed(botId, this.getAttribute('data-row-index'), this); });
      if (btnDoneWl) btnDoneWl.addEventListener('click', function () { doMarkWaitlistDone(this.getAttribute('data-row-index'), this); });
      if (btnHandled) btnHandled.addEventListener('click', function () { doMarkWaitlistHandled(this.getAttribute('data-row-index'), this); });
      listEl.appendChild(div);
    });
  } catch (err) {
    listEl.innerHTML = '<div style="color:#999; font-size:12px;">載入候補清單失敗</div>';
  }
}

function getOperatorName() {
  var el = document.getElementById('operator_name');
  return el ? String(el.value || '').trim() : '';
}

/** 該列候補的三顆按鈕：loading=true 時全部 disabled、被點的那顆顯示「處理中…」；loading=false 時還原 */
function setWaitlistRowButtonsState(buttonEl, loading) {
  if (!buttonEl || !buttonEl.closest) return;
  var item = buttonEl.closest('.waitlist-item');
  if (!item) return;
  var btns = item.querySelectorAll('.row-btns button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (loading) {
      b.setAttribute('data-waitlist-original', b.textContent);
      b.disabled = true;
      if (b === buttonEl) b.textContent = '處理中…';
    } else {
      b.disabled = false;
      var orig = b.getAttribute('data-waitlist-original');
      if (orig != null) b.textContent = orig;
      b.removeAttribute('data-waitlist-original');
    }
  }
}

async function doMarkWaitlistPushed(botId, rowIndex, buttonEl) {
  if (!botId || !rowIndex) return;
  setWaitlistRowButtonsState(buttonEl, true);
  var operatorName = getOperatorName();
  try {
    var url = `${GAS_API_URL}?action=markWaitlistPushed&botId=${encodeURIComponent(botId)}&rowIndex=${encodeURIComponent(rowIndex)}`;
    if (operatorName) url += '&operator_name=' + encodeURIComponent(operatorName);
    var resp = await fetch(url);
    var data = await resp.json();
    if (data.status === 'success') fetchWaitlist(botId);
    else { alert(data.message || '傳送失敗'); setWaitlistRowButtonsState(buttonEl, false); }
  } catch (err) { alert('連線失敗'); setWaitlistRowButtonsState(buttonEl, false); }
}

async function doMarkWaitlistDone(rowIndex, buttonEl) {
  if (!rowIndex) return;
  setWaitlistRowButtonsState(buttonEl, true);
  var operatorName = getOperatorName();
  try {
    var url = `${GAS_API_URL}?action=markWaitlistDone&rowIndex=${encodeURIComponent(rowIndex)}`;
    if (operatorName) url += '&operator_name=' + encodeURIComponent(operatorName);
    var resp = await fetch(url);
    var data = await resp.json();
    if (data.status === 'success' && currentBotId) fetchWaitlist(currentBotId);
    else { if (data.message) alert(data.message); setWaitlistRowButtonsState(buttonEl, false); }
  } catch (err) { alert('連線失敗'); setWaitlistRowButtonsState(buttonEl, false); }
}

async function doMarkWaitlistHandled(rowIndex, buttonEl) {
  if (!rowIndex) return;
  setWaitlistRowButtonsState(buttonEl, true);
  var operatorName = getOperatorName();
  try {
    var url = `${GAS_API_URL}?action=markWaitlistHandled&rowIndex=${encodeURIComponent(rowIndex)}`;
    if (operatorName) url += '&operator_name=' + encodeURIComponent(operatorName);
    var resp = await fetch(url);
    var data = await resp.json();
    if (data.status === 'success' && currentBotId) fetchWaitlist(currentBotId);
    else { if (data.message) alert(data.message); setWaitlistRowButtonsState(buttonEl, false); }
  } catch (err) { alert('連線失敗'); setWaitlistRowButtonsState(buttonEl, false); }
}

var waitlistModalUserId = null;
var waitlistModalUserName = '';

function openWaitlistModal(userId, name) {
  waitlistModalUserId = userId;
  waitlistModalUserName = (name != null && typeof name === 'string') ? name : '';
  var modal = document.getElementById('waitlist-modal');
  var dateInput = document.getElementById('waitlist-date');
  var timeInput = document.getElementById('waitlist-time');
  if (modal) modal.style.display = 'flex';
  if (dateInput) {
    var today = new Date();
    dateInput.value = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().split('T')[0];
  }
  if (timeInput) timeInput.value = '';
}

function closeWaitlistModal() {
  var modal = document.getElementById('waitlist-modal');
  if (modal) modal.style.display = 'none';
  waitlistModalUserId = null;
  waitlistModalUserName = '';
}

// 輔助：HH:MM轉分鐘
function hhmmToMinutes(str) {
  const p = str.split(':');
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}

document.addEventListener('DOMContentLoaded', () => {
  refreshData();
  document.getElementById('btn-reload-page').addEventListener('click', () => refreshData());

  // 問題回報 / 建議按鈕（放在重整旁邊）
  const btnFeedback = document.getElementById('btn-feedback');
  if (btnFeedback) {
    btnFeedback.addEventListener('click', () => {
      // 若有指定 Email，優先開啟預填寫的 mailto 連結
      const FEEDBACK_EMAIL = "paopaomao.of@gmail.com"; // 例：'you@example.com'
      if (FEEDBACK_EMAIL) {
        const subject = encodeURIComponent("各店訊息一覽 外掛問題 / 建議回報");
        const body = encodeURIComponent(
          [
            "您好，我這邊在使用「各店訊息一覽」外掛時有一些問題或建議：",
            "",
            "【請簡單描述狀況或建議】",
            "",
            "（可附上截圖，說明目前在哪個畫面、操作了哪些步驟）"
          ].join("\n")
        );
        const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
        chrome.tabs.create({ url: mailtoUrl });
        return;
      }

      // 若未來有正式的問題回報表單，可在這裡填入網址並改成開啟新分頁
      const FEEDBACK_URL = ""; // 例：'https://your-feedback-form-url'
      if (FEEDBACK_URL) {
        chrome.tabs.create({ url: FEEDBACK_URL });
        return;
      }

      // 未設定 Email / 表單網址時的預設提示
      const msg = [
        "若外掛有問題、或有任何改進建議，",
        "請截圖目前畫面，並將說明與截圖傳給系統維護者（工程師／主管）。",
        "",
        "（若之後有專用的 Email 或「問題回報表單」，",
        "  可在程式內填入 FEEDBACK_EMAIL 或 FEEDBACK_URL，",
        "  點擊本按鈕就會自動開啟預填寫的信件或表單。）"
      ].join("\n");
      alert(msg);
    });
  }

  // ----------------------------------------------------
  // 常用文字：可編輯、自動儲存、複製按鈕
  // ----------------------------------------------------
  const quickReplyText = document.getElementById('quick-reply-text');
  const btnCopyQuick = document.getElementById('btn-copy-quick');
  if (quickReplyText) {
    chrome.storage.local.get('quick_reply_text', (result) => {
      quickReplyText.value = (result.quick_reply_text && result.quick_reply_text.trim()) ? result.quick_reply_text : DEFAULT_QUICK_REPLY;
    });
    quickReplyText.addEventListener('change', () => {
      chrome.storage.local.set({ quick_reply_text: quickReplyText.value });
    });
    quickReplyText.addEventListener('blur', () => {
      chrome.storage.local.set({ quick_reply_text: quickReplyText.value });
    });
  }
  if (btnCopyQuick && quickReplyText) {
    btnCopyQuick.addEventListener('click', () => {
      quickReplyText.select();
      navigator.clipboard.writeText(quickReplyText.value).then(() => {
        const orig = btnCopyQuick.textContent;
        btnCopyQuick.textContent = '已複製！';
        btnCopyQuick.style.backgroundColor = '#1b5e20';
        setTimeout(() => { btnCopyQuick.textContent = orig; btnCopyQuick.style.backgroundColor = ''; }, 1500);
      });
    });
  }

  // ----------------------------------------------------
  // 可收合區塊：點標題展開／收合
  // ----------------------------------------------------
  document.querySelectorAll('.collapsible-header').forEach(function (header) {
    var targetId = header.getAttribute('data-toggle');
    if (!targetId) return;
    var body = document.getElementById(targetId);
    var chevron = header.querySelector('.collapsible-chevron');
    if (!body) return;
    header.addEventListener('click', function () {
      var isCollapsed = body.classList.toggle('collapsed');
      if (chevron) chevron.textContent = isCollapsed ? '▶' : '▼';
      header.setAttribute('aria-expanded', !isCollapsed);
      if (!isCollapsed && targetId === 'availability-body') {
        var advStart = document.getElementById('adv-start');
        var advEnd = document.getElementById('adv-end');
        if (advStart && advEnd && !advStart.value) {
          var today = new Date();
          var nextWeek = new Date();
          nextWeek.setDate(today.getDate() + 7);
          advStart.value = today.toISOString().split('T')[0];
          advEnd.value = nextWeek.toISOString().split('T')[0];
        }
      }
    });
  });

  // ----------------------------------------------------
  // [功能] 進階搜尋 (智慧過濾 + 純文字)
  // ----------------------------------------------------
  const btnRunSearch = document.getElementById('btn-run-search');
  const boxResultContainer = document.getElementById('adv-result-container');
  const txtResult = document.getElementById('adv-result-text');
  const btnCopyTxt = document.getElementById('btn-copy-txt');

  if (btnRunSearch) {
    btnRunSearch.addEventListener('click', async () => {
      const sDate = document.getElementById('adv-start').value;
      const eDate = document.getElementById('adv-end').value;
      const people = document.getElementById('adv-people').value;
      const duration = document.getElementById('adv-duration').value;
      const timeRange = document.getElementById('adv-time-range').value.split('-'); 
      const checkboxes = document.querySelectorAll('input[name="adv-week"]:checked');
      const weekDays = Array.from(checkboxes).map(cb => cb.value).join(',');

      if (!sDate || !eDate) { alert("請選擇日期範圍"); return; }

      btnRunSearch.disabled = true;
      btnRunSearch.textContent = "搜尋中...";
      boxResultContainer.style.display = 'block';
      txtResult.value = '正在分析大數據...';

      try {
        const timestamp = new Date().getTime();
        const url = `${GAS_API_URL}?action=searchAvailability&botId=${currentBotId}&startDate=${sDate}&endDate=${eDate}&people=${people}&duration=${duration}&weekDays=${weekDays}&timeStart=${timeRange[0]}&timeEnd=${timeRange[1]}&_t=${timestamp}`;
        const resp = await fetch(url);
        const json = await resp.json();

        if (json.status === 'success') {
          // GAS getSlots/searchAvailability 回傳 { status, text }（多行字串），非 { status, data }
          if (json.text !== undefined && json.text !== null) {
            txtResult.value = json.text;
          } else if (json.data && Array.isArray(json.data)) {
            if (json.data.length === 0) {
              txtResult.value = '⚠️ 搜尋完成，但沒有符合條件的時段。';
            } else {
              let resultStr = "";
              json.data.forEach(day => {
                const dateStr = (day && day.date) ? String(day.date).slice(5).replace('-', '/') : '';
                const weekStr = (day && day.week) ? day.week : '';
                const times = Array.isArray(day && day.times) ? day.times : [];
                const smartTimes = [];
                let lastTimeMinutes = -999;
                times.forEach(t => {
                  if (t == null) return;
                  const currentMinutes = hhmmToMinutes(t);
                  if (currentMinutes !== lastTimeMinutes + 30) smartTimes.push(t);
                  lastTimeMinutes = currentMinutes;
                });
                resultStr += `${dateStr} (${weekStr}) ${smartTimes.join(", ")}\n`;
              });
              txtResult.value = resultStr;
            }
          } else {
            txtResult.value = '⚠️ 回傳格式異常，請稍後再試。';
          }
        } else {
          var errMsg = "錯誤: " + (json.error || json.message || "未知錯誤");
          if (json.details) errMsg += "\n" + json.details;
          txtResult.value = errMsg;
        }
      } catch (err) {
        txtResult.value = "連線失敗: " + err;
      } finally {
        btnRunSearch.disabled = false;
        btnRunSearch.textContent = "開始搜尋";
      }
    });
  }

  if(btnCopyTxt) {
    btnCopyTxt.addEventListener('click', () => {
      txtResult.select();
      navigator.clipboard.writeText(txtResult.value).then(() => {
        const originalText = btnCopyTxt.textContent;
        btnCopyTxt.textContent = "已複製！";
        btnCopyTxt.style.backgroundColor = "#28a745"; 
        setTimeout(() => {
          btnCopyTxt.textContent = originalText;
          btnCopyTxt.style.backgroundColor = "#17a2b8"; 
        }, 1500);
      });
    });
  }

  // ----------------------------------------------------
  // 會員查詢
  // ----------------------------------------------------
  const btnCheckMember = document.getElementById('btn-check-member');
  const divMemberInfo = document.getElementById('member-info');
  const divBookingDetails = document.getElementById('booking-details');

  btnCheckMember.addEventListener('click', async () => {
    const phone = document.getElementById('bk-phone').value.trim();
    if (!phone) { alert("請輸入手機"); return; }
    
    btnCheckMember.disabled = true;
    btnCheckMember.textContent = "...";
    divBookingDetails.style.display = 'none'; 

    try {
      const resp = await fetch(`${GAS_API_URL}?action=checkMember&botId=${currentBotId}&phone=${phone}`);
      const data = await resp.json();

      if (data.status === 'success') {
        divMemberInfo.textContent = `👋 哈囉，${data.name}`;
        divBookingDetails.style.display = 'block'; 
        
        // 如果預設日期沒值，填入今天
        const currentPicked = document.getElementById('bk-date').value;
        if (!currentPicked) {
           const today = new Date().toISOString().split('T')[0];
           document.getElementById('bk-date').value = today;
        }
      } else {
        divMemberInfo.textContent = "❌ 查無會員";
        divMemberInfo.style.color = "red";
      }
    } catch (err) {
      alert("查詢失敗");
    } finally {
      btnCheckMember.disabled = false;
      btnCheckMember.textContent = "查詢";
    }
  });

  // ----------------------------------------------------
  // 預約送出 (支援多人)
  // ----------------------------------------------------
  document.getElementById('btn-submit-booking').addEventListener('click', async () => {
    const phone = document.getElementById('bk-phone').value.trim();
    const date = document.getElementById('bk-date').value; 
    const time = document.getElementById('bk-time').value;
    const duration = document.getElementById('bk-duration').value;
    const people = document.getElementById('bk-people').value; // [新增]
    const remark = document.getElementById('bk-remark').value;

    if (!date || !time || !duration || !people) { alert("請完整填寫日期、時間、人數"); return; }
    
    // 確認視窗加入人數資訊
    if(!confirm(`確認預約？\n\n手機: ${phone}\n時間: ${date} ${time}\n人數: ${people} 位\n時長: ${duration}hr`)) return;

    const btn = document.getElementById('btn-submit-booking');
    btn.disabled = true;
    btn.textContent = "處理中...";

    try {
      // 傳送 people 參數
      const url = `${GAS_API_URL}?action=createBooking&botId=${currentBotId}&phone=${phone}&date=${date}&time=${time}&duration=${duration}&people=${people}&remark=${encodeURIComponent(remark)}`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.status === 'success') {
        alert("✅ 預約成功！");
        divMemberInfo.textContent = '';
        divBookingDetails.style.display = 'none';
        document.getElementById('bk-phone').value = '';
      } else {
        alert("❌ 預約失敗: " + (data.details || data.error));
      }
    } catch (err) { alert("連線失敗"); } 
    finally { btn.disabled = false; btn.textContent = "🚀 確認預約"; }
  });

  // 候補清單：排候補彈窗送出／取消
  const waitlistModal = document.getElementById('waitlist-modal');
  const waitlistDate = document.getElementById('waitlist-date');
  const waitlistTime = document.getElementById('waitlist-time');
  const waitlistPeople = document.getElementById('waitlist-people');
  const waitlistRemark = document.getElementById('waitlist-remark');
  const waitlistModalSubmit = document.getElementById('waitlist-modal-submit');
  const waitlistModalCancel = document.getElementById('waitlist-modal-cancel');
  if (waitlistModalSubmit && waitlistDate) {
    waitlistModalSubmit.addEventListener('click', async () => {
      var dateVal = waitlistDate.value.trim();
      if (!dateVal) { alert('請選擇候補日期'); return; }
      var timeVal = (waitlistTime && waitlistTime.value) ? waitlistTime.value.trim() : '';
      var peopleVal = (waitlistPeople && waitlistPeople.value !== '') ? Math.max(1, parseInt(waitlistPeople.value, 10) || 1) : 1;
      var remarkVal = (waitlistRemark && waitlistRemark.value) ? waitlistRemark.value.trim() : '';
      if (!currentBotId || !waitlistModalUserId) { alert('請重新開啟此視窗'); closeWaitlistModal(); return; }
      waitlistModalSubmit.disabled = true;
      waitlistModalSubmit.textContent = '送出中...';
      try {
        var url = `${GAS_API_URL}?action=addWaitlist&botId=${encodeURIComponent(currentBotId)}&date=${encodeURIComponent(dateVal)}&userId=${encodeURIComponent(waitlistModalUserId)}`;
        if (timeVal) url += '&time=' + encodeURIComponent(timeVal);
        if (peopleVal > 1) url += '&people=' + encodeURIComponent(peopleVal);
        if (waitlistModalUserName) url += '&name=' + encodeURIComponent(waitlistModalUserName);
        if (remarkVal) url += '&remark=' + encodeURIComponent(remarkVal);
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.status === 'success') {
          closeWaitlistModal();
          fetchWaitlist(currentBotId);
          alert('已加入候補清單');
        } else {
          alert(data.message || '加入失敗');
        }
      } catch (err) { alert('連線失敗'); }
      finally { waitlistModalSubmit.disabled = false; waitlistModalSubmit.textContent = '送出'; }
    });
  }
  if (waitlistModalCancel) waitlistModalCancel.addEventListener('click', closeWaitlistModal);
  if (waitlistModal) {
    waitlistModal.addEventListener('click', function (e) {
      if (e.target === waitlistModal) closeWaitlistModal();
    });
  }

  // 搜尋過濾：篩選後更新狀態為「可見筆數」，避免顯示「69 則」但列表空白（搜尋無符合）
  const searchInputEl = document.getElementById('input-search');
  if (searchInputEl) {
    searchInputEl.addEventListener('input', (e) => {
      const keyword = e.target.value.toLowerCase().trim();
      const items = document.querySelectorAll('.msg-item');
      let visibleCount = 0;
      items.forEach(item => {
        const text = item.getAttribute('data-search') || '';
        const show = !keyword || text.includes(keyword);
        item.style.display = show ? '' : 'none';
        if (show) visibleCount++;
      });
      const total = items.length;
      if (total > 0) updateMsgStatus(total, visibleCount);
    });
  }

  // 搜尋欄右側「刪除」按鈕：清空並恢復全部訊息
  const clearBtn = document.getElementById('btn-clear-search');
  if (clearBtn && searchInputEl) {
    clearBtn.addEventListener('click', () => {
      searchInputEl.value = '';
      const ev = new Event('input', { bubbles: true });
      searchInputEl.dispatchEvent(ev);
      searchInputEl.focus();
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) refreshData();
});
chrome.tabs.onActivated.addListener(() => refreshData());