#!/usr/bin/env node
/**
 * OpenClaw 智能分層路由器
 * 集成分層AI路由到OpenClaw會話系統
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 環境變數
const ENV_VARS = {
    GEMINI_API_KEY: 'REDACTED_GEMINI_KEY',
    ANTHROPIC_API_KEY: 'REDACTED_ANTHROPIC_KEY'
};

/**
 * 使用智能分層路由處理消息
 */
async function smartRoute(message, options = {}) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'smart_hierarchical_router.py');
        const child = spawn('python3', [scriptPath, message], {
            env: { ...process.env, ...ENV_VARS },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => stdout += data.toString());
        child.stderr.on('data', (data) => stderr += data.toString());

        child.on('close', (code) => {
            if (code === 0) {
                // 解析路由信息
                const routingInfo = extractRoutingInfo(stderr);
                resolve({
                    response: stdout.trim(),
                    routing: routingInfo,
                    rawStderr: stderr
                });
            } else {
                reject(new Error(`Smart Router failed: ${stderr}`));
            }
        });
    });
}

/**
 * 從stderr提取路由信息
 */
function extractRoutingInfo(stderr) {
    const info = {
        method: 'unknown',
        model: 'unknown', 
        costLevel: 0,
        reasoning: ''
    };

    const methodMatch = stderr.match(/方法: (.+)/);
    const modelMatch = stderr.match(/選擇: (.+)/);
    const costMatch = stderr.match(/成本: Level (\d+)/);
    const reasonMatch = stderr.match(/理由: (.+)/);

    if (methodMatch) info.method = methodMatch[1];
    if (modelMatch) info.model = modelMatch[1];  
    if (costMatch) info.costLevel = parseInt(costMatch[1]);
    if (reasonMatch) info.reasoning = reasonMatch[1];

    return info;
}

/**
 * 為子任務生成優化的spawn參數
 */
function generateSubtaskSpawn(task, suggestedModel = null) {
    let model = suggestedModel;
    
    // 如果沒有建議，快速判斷
    if (!model) {
        const taskLower = task.toLowerCase();
        if (taskLower.includes('監控') || taskLower.includes('狀態') || taskLower.includes('檢查')) {
            model = 'google/gemini-2.5-flash';
        } else if (taskLower.includes('程式') || taskLower.includes('code') || taskLower.includes('分析')) {
            model = 'anthropic/claude-sonnet-4-20250514';
        } else {
            model = 'anthropic/claude-opus-4-6';
        }
    }

    return {
        task: task,
        model: model,
        mode: 'run',
        cleanup: 'delete',
        timeoutSeconds: 300
    };
}

/**
 * CLI 主函數
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('OpenClaw 智能分層路由器');
        console.log('');
        console.log('使用方法：');
        console.log('  openclaw_smart_router.js "<任務>" [選項]');
        console.log('');
        console.log('範例：');
        console.log('  openclaw_smart_router.js "檢查系統狀態"');
        console.log('  openclaw_smart_router.js "寫個Python函數計算薪資"');
        console.log('  openclaw_smart_router.js "設計員工管理系統架構"');
        console.log('');
        console.log('特色：');
        console.log('  🚀 自動選擇最合適的AI模型');
        console.log('  💰 優化成本效益');
        console.log('  🧠 Opus當架構師，Sonnet做分析，Flash跑監控');
        process.exit(0);
    }

    const message = args[0];
    
    try {
        console.error('🤖 泡泡貓智能路由啟動...');
        
        const result = await smartRoute(message);
        
        // 輸出路由決策信息
        const routing = result.routing;
        console.error(`\n📊 智能決策：${routing.method} → ${routing.model} (Level ${routing.costLevel})`);
        console.error(`💡 理由：${routing.reasoning}`);
        
        // 輸出實際回應
        console.log(result.response);
        
        // 成本報告
        const costEmoji = routing.costLevel <= 3 ? '💚' : routing.costLevel <= 15 ? '💛' : '🔴';
        console.error(`${costEmoji} 成本評級：Level ${routing.costLevel}`);
        
    } catch (error) {
        console.error('❌ 智能路由失敗:', error.message);
        process.exit(1);
    }
}

// 直接執行時運行main
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { smartRoute, generateSubtaskSpawn };