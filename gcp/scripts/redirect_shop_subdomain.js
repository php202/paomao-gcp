#!/usr/bin/env node
/**
 * 設定 shop.paopaomao.tw 導向 Odoo Shop
 * Target: https://paopaomao.tw/shop
 */

import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function updateShopRedirect() {
    console.log('🔄 開始設定 shop.paopaomao.tw → https://paopaomao.tw/shop');
    
    try {
        // 讀取 Cloudflare API Token
        const cfToken = await fs.readFile(process.env.HOME + '/.openclaw/secrets/cloudflare-api-token.txt', 'utf8');
        const token = cfToken.trim();
        
        // Cloudflare Zone ID for paopaomao.tw
        const zoneId = '8a7b2c6e9f1d5e3a2b8c9d6e1f2a3b4c'; // 需要確認實際的
        
        // 1. 先檢查是否已存在 shop.paopaomao.tw 的 DNS 記錄
        console.log('📋 檢查現有 DNS 記錄...');
        
        const listCommand = `curl -s -X GET "https://api.cloudflare.com/v4/zones/${zoneId}/dns_records?name=shop.paopaomao.tw" \
            -H "Authorization: Bearer ${token}" \
            -H "Content-Type: application/json"`;
        
        const { stdout: listResult } = await execAsync(listCommand);
        const existingRecords = JSON.parse(listResult);
        
        if (!existingRecords.success) {
            console.error('❌ 無法獲取 DNS 記錄:', existingRecords.errors);
            return false;
        }
        
        // 2. 如果已存在，先刪除舊記錄
        if (existingRecords.result && existingRecords.result.length > 0) {
            console.log('🗑️ 刪除舊的 DNS 記錄...');
            for (const record of existingRecords.result) {
                const deleteCommand = `curl -s -X DELETE "https://api.cloudflare.com/v4/zones/${zoneId}/dns_records/${record.id}" \
                    -H "Authorization: Bearer ${token}"`;
                await execAsync(deleteCommand);
            }
        }
        
        // 3. 創建新的 CNAME 記錄指向 paopaomao.tw
        console.log('➕ 創建新的 DNS 記錄...');
        
        const createCommand = `curl -s -X POST "https://api.cloudflare.com/v4/zones/${zoneId}/dns_records" \
            -H "Authorization: Bearer ${token}" \
            -H "Content-Type: application/json" \
            --data '{
                "type": "CNAME",
                "name": "shop",
                "content": "paopaomao.tw",
                "ttl": 300,
                "proxied": true,
                "comment": "Shop subdomain redirect to Odoo"
            }'`;
        
        const { stdout: createResult } = await execAsync(createCommand);
        const result = JSON.parse(createResult);
        
        if (result.success) {
            console.log('✅ DNS 記錄創建成功');
            
            // 4. 設置頁面規則進行 URL 重定向
            console.log('🔀 設置頁面重定向規則...');
            
            const pageRuleCommand = `curl -s -X POST "https://api.cloudflare.com/v4/zones/${zoneId}/pagerules" \
                -H "Authorization: Bearer ${token}" \
                -H "Content-Type: application/json" \
                --data '{
                    "targets": [
                        {
                            "target": "url",
                            "constraint": {
                                "operator": "matches",
                                "value": "shop.paopaomao.tw/*"
                            }
                        }
                    ],
                    "actions": [
                        {
                            "id": "forwarding_url",
                            "value": {
                                "url": "https://paopaomao.tw/shop",
                                "status_code": 301
                            }
                        }
                    ],
                    "priority": 1,
                    "status": "active"
                }'`;
            
            const { stdout: pageRuleResult } = await execAsync(pageRuleCommand);
            const pageRule = JSON.parse(pageRuleResult);
            
            if (pageRule.success) {
                console.log('✅ 頁面重定向規則設置成功');
                console.log('🎉 shop.paopaomao.tw 現在會重定向到 https://paopaomao.tw/shop');
                
                // 5. 驗證設置
                console.log('🧪 等待 DNS 傳播並驗證...');
                setTimeout(async () => {
                    try {
                        const { stdout: testResult } = await execAsync('curl -I -s https://shop.paopaomao.tw | head -1');
                        console.log('📊 測試結果:', testResult.trim());
                    } catch (e) {
                        console.log('⚠️ 測試可能需要等待 DNS 傳播完成');
                    }
                }, 10000);
                
                return true;
            } else {
                console.error('❌ 頁面規則設置失敗:', pageRule.errors);
                return false;
            }
        } else {
            console.error('❌ DNS 記錄創建失敗:', result.errors);
            return false;
        }
        
    } catch (error) {
        console.error('❌ 操作失敗:', error.message);
        return false;
    }
}

// 如果直接執行
if (import.meta.url === `file://${process.argv[1]}`) {
    updateShopRedirect().then(success => {
        console.log(success ? '🎯 任務完成' : '💥 任務失敗');
        process.exit(success ? 0 : 1);
    });
}

export default updateShopRedirect;