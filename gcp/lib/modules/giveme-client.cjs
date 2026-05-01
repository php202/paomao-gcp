/**
 * 🔌 GiveMe API 客戶端模組
 * 負責與 GiveMe 電子發票 API 的所有通信
 */

const crypto = require('crypto');
const _nf = require('node-fetch');
const fetch = _nf.default || _nf;

class GiveMeClient {
  constructor(config = {}) {
    this.config = {
      uncode: config.uncode || '94256530',
      idno: config.idno || '94256530',
      password: config.password || '2ymf5LX7wkXWT1c5GpeC',
      b2bUrl: config.b2bUrl || 'http://35.221.248.175:8080/invoice',
      timeout: config.timeout || 30000
    };
  }

  /**
   * 🔐 生成簽章
   */
  generateSign(timeStamp) {
    return crypto.createHash('md5')
      .update(timeStamp + this.config.idno + this.config.password)
      .digest('hex').toUpperCase();
  }

  /**
   * 📄 準備發票資料
   */
  prepareInvoiceData({ buyerTaxId, buyerName, buyerEmail, amount, items, content }) {
    const sales = Math.round(amount / 1.05);
    const taxAmount = amount - sales;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const timeStamp = Date.now().toString();
    
    const payload = {
      timeStamp,
      uncode: this.config.uncode,
      idno: this.config.idno,
      sign: this.generateSign(timeStamp),
      phone: buyerTaxId,
      datetime: today,
      email: buyerEmail || '',
      taxState: '0',
      totalFee: String(amount),
      amount: String(taxAmount),
      sales: String(sales),
      content: (content || '').substring(0, 200),
      items: JSON.stringify(items)
    };
    
    if (buyerName) payload.customerName = buyerName;
    
    return payload;
  }

  /**
   * 📡 發送 API 請求
   */
  async sendRequest(payload) {
    const response = await fetch(this.config.b2bUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: this.config.timeout
    });

    if (!response.ok) {
      throw new Error(`GiveMe API HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[giveme-client] API 回傳: ${JSON.stringify(result).substring(0, 300)}`);
    
    if (result.status === '1' || result.success === 'true') {
      // GiveMe 回傳發票號碼在 code 欄位
      const invoiceNo = result.code || result.invoiceNumber || result.invoiceNum || result.number;
      return { invoiceNo };
    } else {
      throw new Error(`GiveMe API 錯誤: ${result.msg || '開票失敗'}`);
    }
  }

  /**
   * 🎯 開立發票主方法
   */
  async issueInvoice(params) {
    const payload = this.prepareInvoiceData(params);
    return await this.sendRequest(payload);
  }
}

module.exports = { GiveMeClient };