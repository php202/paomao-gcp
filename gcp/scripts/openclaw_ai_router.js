#!/usr/bin/env node
/**
 * OpenClaw AI Router - 智能模型路由中間件
 * 根據消息複雜度自動選擇最合適的模型
 * 
 * Usage: 
 *   openclaw_ai_router.js "<message>" [system_prompt]
 *   export OPENCLAW_SMART_ROUTING=true && openclaw sessions spawn --task "任務"
 */

import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 模型映射表
const MODELS = {
    flash: 'google/gemini-2.5-flash',
    sonnet: 'anthropic/claude-sonnet-4-20250514', 
    opus: 'anthropic/claude-opus-4-6'
};

// 環境變數設定
const ENV_VARS = {
    GEMINI_API_KEY: 'REDACTED_GEMINI_KEY',
    ANTHROPIC_API_KEY: 'REDACTED_ANTHROPIC_KEY'
};

/**
 * 調用Python AI Router並返回結果
 */
async function routeMessage(message, systemPrompt = null) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'ai_router.py');
        const args = [scriptPath, message];
        if (systemPrompt) args.push(systemPrompt);

        const child = spawn('python3', args, {
            env: { ...process.env, ...ENV_VARS },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                // 從stderr提取模型選擇信息
                const modelMatch = stderr.match(/🤖 Selected: (\w+) \((.+?)\) - Cost Level: (\d+)/);
                resolve({
                    response: stdout.trim(),
                    selectedTier: modelMatch ? modelMatch[1] : 'unknown',
                    modelName: modelMatch ? modelMatch[2] : 'unknown',
                    costLevel: modelMatch ? parseInt(modelMatch[3]) : 0,
                    stderr: stderr
                });
            } else {
                reject(new Error(`AI Router failed: ${stderr}`));
            }
        });
    });
}

/**
 * 更新OpenClaw cron任務使用智能路由
 */
function updateCronWithSmartRouting(cronId, taskMessage) {
    
    // 包裝任務訊息，讓它使用AI router
    const wrappedMessage = `Execute: cd /Users/paopaomao/paomao-gcp/gcp/scripts && node openclaw_ai_router.js "${taskMessage.replace(/"/g, '\\"')}"`;
    
    exec(`openclaw cron edit "${cronId}" --message "${wrappedMessage}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Failed to update cron ${cronId}:`, error.message);
        } else {
            console.log(`✅ Updated cron ${cronId} with smart routing`);
        }
    });
}

/**
 * 批量更新所有cron任務使用智能路由
 */
async function enableSmartRoutingForAllCrons() {
    
    exec('openclaw cron list --json 2>/dev/null', async (error, stdout) => {
        if (error) {
            console.error('Failed to list crons:', error.message);
            return;
        }
        
        try {
            const crons = JSON.parse(stdout);
            for (const cron of crons) {
                if (cron.payload && cron.payload.message) {
                    // 只更新還沒包裝的任務
                    if (!cron.payload.message.includes('openclaw_ai_router.js')) {
                        updateCronWithSmartRouting(cron.id, cron.payload.message);
                        await new Promise(resolve => setTimeout(resolve, 500)); // 避免API限制
                    }
                }
            }
        } catch (e) {
            console.error('Failed to parse cron list:', e.message);
        }
    });
}

// CLI 介面
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.error('Usage: openclaw_ai_router.js "<message>" [system_prompt]');
        console.error('       openclaw_ai_router.js --enable-smart-routing  (update all crons)');
        process.exit(1);
    }
    
    if (args[0] === '--enable-smart-routing') {
        console.log('🤖 Enabling smart routing for all cron jobs...');
        await enableSmartRoutingForAllCrons();
        return;
    }
    
    const message = args[0];
    const systemPrompt = args[1] || null;
    
    try {
        const result = await routeMessage(message, systemPrompt);
        
        // 輸出模型選擇信息到stderr（供OpenClaw日誌）
        console.error(`🤖 Smart Router: ${result.selectedTier} (${result.modelName}) - Cost Level: ${result.costLevel}`);
        
        // 輸出實際回應到stdout
        console.log(result.response);
        
    } catch (error) {
        console.error('❌ AI Router Error:', error.message);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { routeMessage, updateCronWithSmartRouting };