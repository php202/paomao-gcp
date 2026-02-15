// ==UserScript==
// @name         SayDou Auto Login
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自動填寫 SayDou 登入資料並可選擇自動按登入
// @match        https://m.saydou.com/login*
// @grant        none
// ==/UserScript==
// 由 build.js 從 gas/.env 產生，請勿手動編輯

(function() {
  'use strict';

  // 從 gas/.env 注入（執行 npm run build:tampermonkey 產生）
  const MY_CSTCOD = '__SAYDOU_CSTCOD__';
  const MY_USRACC = '__SAYDOU_USRACC__';
  const MY_PASSWD = '__SAYDOU_PASSWD__';
  const AUTO_SUBMIT = __SAYDOU_AUTO_SUBMIT__;

  function setValueAndDispatch(el, value) {
    if (!el) return;
    el.value = value;
    // 讓 Angular 的 form control 也收到變更
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function tryFillAndLogin() {
    // 盡量用 name / formcontrolname，比 mat-input-0 穩定
    const cstcod = document.querySelector('input[name="cstcod"][formcontrolname="cstcod"]');
    const usracc = document.querySelector('input[name="usracc"][formcontrolname="usracc"]');
    const passwd = document.querySelector('input[name="passwd"][formcontrolname="passwd"]');

    if (!cstcod || !usracc || !passwd) {
      return false; // 表單還沒載好
    }

    setValueAndDispatch(cstcod, MY_CSTCOD);
    setValueAndDispatch(usracc, MY_USRACC);
    setValueAndDispatch(passwd, MY_PASSWD);

    if (AUTO_SUBMIT) {
      // 等 Angular 反應完，把按鈕 enable，稍微等一下再按
      setTimeout(() => {
        // 找出「登入」按鈕
        const buttons = Array.from(document.querySelectorAll('button'));
        const loginBtn = buttons.find(btn =>
          /登入/.test(btn.innerText || btn.textContent || '')
        );
        if (loginBtn && !loginBtn.disabled) {
          loginBtn.click();
        }
      }, 1000);
    }

    return true;
  }

  // 因為是 Angular 頁面，DOM 會慢一點才有，輪詢幾次
  let tries = 0;
  const maxTries = 20;
  const timer = setInterval(() => {
    if (tryFillAndLogin() || ++tries >= maxTries) {
      clearInterval(timer);
    }
  }, 500);
})();
