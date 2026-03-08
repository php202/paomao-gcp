#!/usr/bin/env python3
"""
分層 AI 路由器 - Opus 當架構師版本
Level 1: 快速過濾（規則）
Level 2: Sonnet 初步規劃  
Level 3: Opus 深度規劃（復雜任務）
"""

import os
import sys
import json
import re
from ai_router import call_model, MODELS

def quick_filter(message: str) -> str:
    """Level 1: 快速規則過濾，明顯簡單的直接分配"""
    msg = message.lower()
    
    # 超簡單任務 → 直接 Flash
    simple_patterns = [
        r'^(狀態|status|檢查|查看|顯示|list)$',
        r'^(時間|日期|今天).*',
        r'查無.*紀錄',
        r'^(是|否|yes|no)$'
    ]
    
    if any(re.search(p, msg) for p in simple_patterns):
        return 'flash'
    
    # 明確緊急/架構 → 直接 Opus  
    critical_patterns = [
        r'(緊急|urgent|critical|系統.*down|架構.*設計)',
        r'(database.*schema|重新.*設計|策略.*規劃)',
        r'(風險.*評估|重大.*決策)'
    ]
    
    if any(re.search(p, msg) for p in critical_patterns):
        return 'opus'
        
    # 其他 → 需要 AI 判斷
    return 'need_ai_planning'

def sonnet_planning(message: str) -> dict:
    """Level 2: Sonnet 做初步任務分析和規劃"""
    
    planning_prompt = f"""分析這個任務，輸出 JSON：
任務：{message}

請分析：
1. 複雜度等級 (1-5)
2. 是否需要分解成子任務
3. 推薦的AI模型
4. 如果需要分解，列出子任務

輸出格式：
{{
  "complexity": 1-5,
  "recommended_model": "flash|sonnet|opus", 
  "needs_decomposition": true/false,
  "subtasks": ["task1", "task2"] or null,
  "reasoning": "簡短說明"
}}"""

    try:
        result = call_model(MODELS['sonnet']['name'], planning_prompt)
        if 'response' in result:
            # 提取JSON部分
            json_match = re.search(r'\{.*\}', result['response'], re.DOTALL)
            if json_match:
                plan = json.loads(json_match.group())
                return plan
    except:
        pass
    
    # Fallback
    return {
        "complexity": 3,
        "recommended_model": "sonnet", 
        "needs_decomposition": False,
        "subtasks": None,
        "reasoning": "分析失敗，使用預設"
    }

def opus_deep_planning(message: str, sonnet_plan: dict) -> dict:
    """Level 3: Opus 深度規劃（複雜任務）"""
    
    deep_prompt = f"""你是系統架構師。分析這個複雜任務：

原始任務：{message}
Sonnet初步分析：{json.dumps(sonnet_plan, ensure_ascii=False)}

請進行深度規劃，輸出詳細執行計劃：

{{
  "execution_plan": [
    {{
      "step": 1,
      "task": "具體任務描述", 
      "model": "推薦模型",
      "estimated_time": "預估時間",
      "dependencies": []
    }}
  ],
  "risk_assessment": "風險評估",
  "success_criteria": "成功標準",
  "fallback_plan": "備案"
}}"""

    try:
        result = call_model(MODELS['opus']['name'], deep_prompt)
        if 'response' in result:
            json_match = re.search(r'\{.*\}', result['response'], re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
    except:
        pass
    
    return {"error": "Opus規劃失敗"}

def hierarchical_route(message: str) -> dict:
    """分層智能路由主函數"""
    
    # Level 1: 快速過濾
    quick_result = quick_filter(message)
    
    if quick_result in ['flash', 'opus']:
        return {
            'final_model': quick_result,
            'method': 'quick_filter',
            'plan': None,
            'cost_estimate': MODELS[quick_result]['cost']
        }
    
    # Level 2: Sonnet 規劃
    sonnet_plan = sonnet_planning(message)
    
    # 如果 Sonnet 認為簡單，就聽它的
    if sonnet_plan['complexity'] <= 2:
        return {
            'final_model': sonnet_plan['recommended_model'],
            'method': 'sonnet_planning',
            'plan': sonnet_plan,
            'cost_estimate': MODELS[sonnet_plan['recommended_model']]['cost']
        }
    
    # Level 3: 複雜任務才用 Opus 深度規劃
    if sonnet_plan['complexity'] >= 4 or sonnet_plan['needs_decomposition']:
        opus_plan = opus_deep_planning(message, sonnet_plan)
        return {
            'final_model': 'opus',
            'method': 'opus_deep_planning', 
            'plan': opus_plan,
            'cost_estimate': MODELS['opus']['cost'] + 10  # 規劃成本
        }
    
    # 中等複雜度，Sonnet 處理
    return {
        'final_model': 'sonnet',
        'method': 'sonnet_planning',
        'plan': sonnet_plan,
        'cost_estimate': MODELS['sonnet']['cost']
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: hierarchical_ai_router.py '<message>'")
        sys.exit(1)
    
    message = sys.argv[1]
    
    # 分層路由決策
    routing_result = hierarchical_route(message)
    
    print(f"🎯 分層路由結果：", file=sys.stderr)
    print(f"   方法: {routing_result['method']}", file=sys.stderr)
    print(f"   模型: {routing_result['final_model']}", file=sys.stderr)
    print(f"   成本: {routing_result['cost_estimate']}", file=sys.stderr)
    
    # 執行最終任務
    model_name = MODELS[routing_result['final_model']]['name']
    
    if routing_result['method'] == 'opus_deep_planning' and 'execution_plan' in routing_result['plan']:
        # 複雜任務：顯示執行計劃
        print("📋 Opus 執行計劃：")
        for step in routing_result['plan']['execution_plan']:
            print(f"步驟 {step['step']}: {step['task']} (模型: {step['model']})")
    else:
        # 一般任務：直接執行
        result = call_model(model_name, message)
        if 'response' in result:
            print(result['response'])
        else:
            print(f"執行失敗: {result}")

if __name__ == '__main__':
    main()