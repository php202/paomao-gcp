#!/usr/bin/env node
/**
 * shop.paopaomao.tw 重定向服務器
 * 重定向所有請求到 https://paopaomao.tw/shop
 */

import http from 'http';
import { URL } from 'url';

const PORT = 3870;
const TARGET_URL = 'https://site.paopaomao.tw/shop';

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    
    // 健康檢查端點
    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'shop-redirect',
            target: TARGET_URL,
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    // 記錄請求
    console.log(`${new Date().toISOString()} - Redirecting ${req.url} to ${TARGET_URL}`);
    
    // 301 永久重定向到 Odoo shop
    res.writeHead(301, {
        'Location': TARGET_URL,
        'Cache-Control': 'public, max-age=3600', // 快取1小時
        'Content-Type': 'text/html'
    });
    
    res.end(`<!DOCTYPE html>
<html>
<head>
    <title>Redirecting to Shop</title>
    <meta http-equiv="refresh" content="0; url=${TARGET_URL}">
</head>
<body>
    <h1>Redirecting to Paopaomao Shop...</h1>
    <p>If you are not redirected automatically, <a href="${TARGET_URL}">click here</a>.</p>
</body>
</html>`);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`🛍️ Shop redirect server running on http://localhost:${PORT}`);
    console.log(`🔄 Redirecting all requests to ${TARGET_URL}`);
});

process.on('SIGTERM', () => {
    console.log('📴 Shop redirect server shutting down...');
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('📴 Shop redirect server shutting down...');
    server.close(() => process.exit(0));
});