const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const app = express();

app.use(express.json());

const ipv4Agent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const axiosOpt = {
  headers: { 'Content-Type': 'application/json' },
  httpAgent: ipv4Agent,
  httpsAgent,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
};

// 開單：addB2C / addB2B（Cloud Run 設 GIVEME_PROXY_URL = http://此VM_IP:8080/invoice）
app.post('/invoice', async (req, res) => {
  const callerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const data = req.body;
    const isB2B = data.phone && /^\d{8}$/.test(data.phone);
    const action = isB2B ? 'addB2B' : 'addB2C';
    const targetUrl = `https://www.giveme.com.tw/invoice.do?action=${action}`;
    console.log(`[${new Date().toLocaleString()}] 來源: ${callerIp} -> ${action}`);
    const response = await axios.post(targetUrl, data, axiosOpt);
    console.log(`> API 回傳: ${JSON.stringify(response.data)}`);
    res.json(response.data);
  } catch (error) {
    console.error(`[錯誤] /invoice 轉發失敗:`, error.message);
    res.status(500).json({ success: 'false', msg: error.message });
  }
});

// 發票圖片：action=picture（Cloud Run 設 GIVEME_PICTURE_PROXY_URL = http://此VM_IP:8080/invoice-picture）
app.post('/invoice-picture', async (req, res) => {
  const callerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const targetUrl = 'https://www.giveme.com.tw/invoice.do?action=picture';
    console.log(`[${new Date().toLocaleString()}] 來源: ${callerIp} -> picture`);
    const response = await axios.post(targetUrl, req.body, {
      ...axiosOpt,
      responseType: 'arraybuffer',
    });
    const contentType = response.headers['content-type'] || 'image/png';
    res.set('Content-Type', contentType);
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error(`[錯誤] /invoice-picture 轉發失敗:`, error.message);
    res.status(500).json({ success: 'false', msg: error.message });
  }
});

app.listen(8080, '0.0.0.0', () => {
  console.log('中繼站已啟動，監聽 Port 8080（/invoice 開單、/invoice-picture 發票圖）');
});
