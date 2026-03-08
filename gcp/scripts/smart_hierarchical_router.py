#!/usr/bin/env python3
"""
泡泡貓智能分層路由 - 最佳成本效益版本
Level 1: 規則快速分流 (0成本)
Level 2: Sonnet 中等規劃 (必要時)  
Level 3: Opus 架構師 (複雜任務)
"""

import os
import sys
import json
import re
from ai_router import call_model, MODELS

def level1_quick_route(message: str) -> str:
    """Level 1: 規則快速分流，明確任務直接分配"""
    msg = message.lower().strip()
    
    # 超簡單 → 直接 Flash
    if any(pattern in msg for pattern in [
        '狀態', 'status', '檢查', '查看', '顯示', 'list',
        '時間', '日期', '今天', '現在',
        '是否', '有沒有', '可以嗎'
    ]):
        return 'flash'
    
    # 明確緊急/架構 → 直接 Opus
    if any(pattern in msg for pattern in [
        '緊急', 'urgent', 'critical', '系統down', '架構設計', 
        '資料庫設計', '重新設計', '整體規劃', '策略制定',
        '風險評估', '重大決策', 'schema'
    ]):
        return 'opus'
    
    # 明確編程 → 直接 Sonnet  
    if any(pattern in msg for pattern in [
        '寫', '程式', 'code', 'function', '函數', '腳本',
        'api', '修改', '除錯', 'debug', '實作'
    ]):
        return 'sonnet'
    
    # 需要AI判斷
    return 'need_planning'

def level2_sonnet_judge(message: str) -> dict:
    """Level 2: Sonnet 做輕量判斷"""
    
    judge_prompt = f"""快速判斷這個任務的複雜度和合適的AI模型。

任務：{message}

回答格式（只要這個JSON，不要其他文字）：
{{"complexity": 1-5, "model": "flash/sonnet/opus", "reason": "一句話理由"}}"""

    try:
        result = call_model(MODELS['sonnet']['name'], judge_prompt)
        if 'response' in result:
            # 提取JSON
            text = result['response'].strip()
            json_match = re.search(r'\{[^}]*"complexity"[^}]*\}', text)
            if json_match:
                judgment = json.loads(json_match.group())
                return judgment
    except Exception as e:
        print(f"Sonnet判斷失敗: {e}", file=sys.stderr)
    
    # Fallback：預設中等複雜度
    return {"complexity": 3, "model": "sonnet", "reason": "判斷失敗，使用預設"}

def level3_opus_architect(message: str) -> dict:
    """Level 3: Opus 架構師深度規劃"""
    
    architect_prompt = f"""你是系統架構師。這個複雜任務需要分解規劃：

{message}

請設計執行計劃，回答JSON格式（不要其他文字）：
{{
  "approach": "整體方法",
  "steps": ["步驟1", "步驟2", "步驟3"],
  "models_needed": ["每步驟用的模型"],
  "estimated_cost": "成本估計",
  "risks": "主要風險"
}}"""

    try:
        result = call_model(MODELS['opus']['name'], architect_prompt)
        if 'response' in result:
            text = result['response'].strip()
            json_match = re.search(r'\{.*\}', text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
    except Exception as e:
        print(f"Opus規劃失敗: {e}", file=sys.stderr)
    
    return {"approach": "直接處理", "steps": [message], "models_needed": ["opus"]}

def smart_route(message: str) -> dict:
    """智能分層路由主邏輯"""
    
    # Level 1: 規則快速分流
    quick_decision = level1_quick_route(message)
    
    if quick_decision != 'need_planning':
        return {
            'chosen_model': quick_decision,
            'method': 'rules',
            'cost_level': MODELS[quick_decision]['cost'],
            'reasoning': f'規則直接判斷為{quick_decision}'
        }
    
    # Level 2: Sonnet 輕量判斷 
    sonnet_judgment = level2_sonnet_judge(message)
    
    # 如果Sonnet認為簡單或中等，就聽它的
    if sonnet_judgment['complexity'] <= 3:
        return {
            'chosen_model': sonnet_judgment['model'],
            'method': 'sonnet_judge', 
            'cost_level': MODELS[sonnet_judgment['model']]['cost'] + 5,  # +5 for planning
            'reasoning': sonnet_judgment['reason']
        }
    
    # Level 3: 複雜任務 → Opus 架構師
    opus_plan = level3_opus_architect(message)
    
    return {
        'chosen_model': 'opus',
        'method': 'opus_architect',
        'cost_level': MODELS['opus']['cost'] + 10,  # +10 for planning
        'reasoning': f"複雜任務，Opus規劃：{opus_plan.get('approach', '深度分析')}",
        'plan': opus_plan
    }

def execute_with_routing(message: str):
    """執行智能路由並處理任務"""
    
    print("🧠 智能分層路由分析中...", file=sys.stderr)
    
    # 路由決策
    routing = smart_route(message)
    
    # 顯示路由結果
    print(f"📊 路由結果：", file=sys.stderr)
    print(f"   方法: {routing['method']}", file=sys.stderr)
    print(f"   選擇: {routing['chosen_model']}", file=sys.stderr)  
    print(f"   成本: Level {routing['cost_level']}", file=sys.stderr)
    print(f"   理由: {routing['reasoning']}", file=sys.stderr)
    
    # 執行任務
    chosen_model = MODELS[routing['chosen_model']]['name']
    
    if routing['method'] == 'opus_architect' and 'plan' in routing:
        # 顯示Opus的執行計劃
        plan = routing['plan']
        print(f"\n🏗️ Opus 架構師計劃：", file=sys.stderr)
        if 'steps' in plan:
            for i, step in enumerate(plan['steps'], 1):
                print(f"   {i}. {step}", file=sys.stderr)
    
    # 實際執行
    print("\n⚡ 執行中...", file=sys.stderr)
    result = call_model(chosen_model, message)
    
    if 'response' in result:
        return result['response']
    else:
        return f"執行失敗: {result}"

def main():
    if len(sys.argv) < 2:
        print("Usage: smart_hierarchical_router.py '<message>'")
        print("Examples:")
        print("  python3 smart_hierarchical_router.py '系統狀態'")
        print("  python3 smart_hierarchical_router.py '寫一個計算薪資的函數'") 
        print("  python3 smart_hierarchical_router.py '設計完整的員工管理系統架構'")
        sys.exit(1)
    
    message = sys.argv[1]
    
    try:
        response = execute_with_routing(message)
        print(response)
    except Exception as e:
        print(f"❌ 系統錯誤: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()