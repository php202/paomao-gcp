#!/usr/bin/env python3
"""
AI Router - 智能模型選擇
根據任務複雜度自動選擇最合適的AI模型
"""

import os
import sys
import json
import re
from typing import Dict, Tuple, Optional
import requests
import time

# 模型配置
MODELS = {
    'flash': {
        'name': 'google/gemini-2.5-flash', 
        'cost': 1,
        'use_for': ['monitor', 'status', 'simple_query', 'data_extraction', 'format']
    },
    'sonnet': {
        'name': 'anthropic/claude-sonnet-4-20250514', 
        'cost': 10,
        'use_for': ['coding', 'analysis', 'complex_query', 'decision', 'conversation']
    },
    'opus': {
        'name': 'anthropic/claude-opus-4-6', 
        'cost': 50,
        'use_for': ['architecture', 'complex_reasoning', 'emergency', 'critical_decision']
    }
}

def analyze_complexity(message: str, context: dict = None) -> str:
    """
    分析訊息複雜度，返回建議模型
    """
    msg = message.lower().strip()
    
    # 緊急/重要關鍵字 → Opus
    critical_keywords = [
        '緊急', 'urgent', 'critical', '故障', '錯誤', 'error', '壞掉', 
        '系統down', '無法', '架構', '重新設計', '策略', '決策',
        '資料庫設計', 'schema', '重大', '影響', '風險'
    ]
    
    if any(kw in msg for kw in critical_keywords):
        return 'opus'
    
    # 程式開發關鍵字 → Sonnet 
    coding_keywords = [
        'code', '程式', '寫', '修改', '除錯', 'debug', 'function', 'api',
        '實作', '開發', 'script', '.py', '.js', '.sql', 'database',
        '邏輯', 'algorithm', '優化', '重構', 'refactor'
    ]
    
    if any(kw in msg for kw in coding_keywords):
        return 'sonnet'
    
    # 分析/決策關鍵字 → Sonnet
    analysis_keywords = [
        '分析', '比較', '建議', '規劃', '評估', '檢討', '策略',
        '為什麼', '如何', '方案', '解決', '改善', '優化'
    ]
    
    if any(kw in msg for kw in analysis_keywords):
        return 'sonnet'
    
    # 簡單監控/狀態 → Flash
    simple_keywords = [
        '狀態', '檢查', '查看', '監控', '報告', 'status', 'check',
        '清單', 'list', '顯示', 'show', '讀取', '查詢'
    ]
    
    if any(kw in msg for kw in simple_keywords):
        return 'flash'
    
    # 根據長度判斷
    if len(msg) < 50:
        return 'flash'
    elif len(msg) < 200:
        return 'sonnet' 
    else:
        return 'opus'

def get_api_key(model_name: str) -> Optional[str]:
    """取得對應模型的API key"""
    if 'claude' in model_name:
        return os.getenv('ANTHROPIC_API_KEY')
    elif 'gemini' in model_name:
        return os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_AI_API_KEY')
    elif 'gpt' in model_name:
        return os.getenv('OPENAI_API_KEY')
    return None

def call_model(model_name: str, message: str, system_prompt: str = None) -> Dict:
    """
    調用指定模型API
    """
    api_key = get_api_key(model_name)
    if not api_key:
        return {'error': f'No API key for {model_name}'}
    
    try:
        if 'claude' in model_name:
            return call_claude(model_name, message, system_prompt, api_key)
        elif 'gemini' in model_name:
            return call_gemini(model_name, message, system_prompt, api_key)
        else:
            return {'error': f'Unsupported model: {model_name}'}
    except Exception as e:
        return {'error': f'API call failed: {str(e)}'}

def call_claude(model: str, message: str, system: str, api_key: str) -> Dict:
    """調用Claude API"""
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    
    messages = [{"role": "user", "content": message}]
    if system:
        data = {
            "model": model.replace('anthropic/', ''),
            "max_tokens": 4096,
            "messages": messages,
            "system": system
        }
    else:
        data = {
            "model": model.replace('anthropic/', ''),
            "max_tokens": 4096, 
            "messages": messages
        }
    
    response = requests.post(url, headers=headers, json=data, timeout=60)
    if response.status_code == 200:
        result = response.json()
        return {
            'response': result['content'][0]['text'],
            'model': model,
            'usage': result.get('usage', {})
        }
    else:
        return {'error': f'Claude API error: {response.status_code} {response.text}'}

def call_gemini(model: str, message: str, system: str, api_key: str) -> Dict:
    """調用Gemini API"""
    import google.generativeai as genai
    genai.configure(api_key=api_key)
    
    model_name = model.replace('google/', '')
    model_obj = genai.GenerativeModel(model_name, system_instruction=system)
    
    response = model_obj.generate_content(message)
    return {
        'response': response.text,
        'model': model,
        'usage': getattr(response, 'usage_metadata', {})
    }

def route_and_call(message: str, system_prompt: str = None, force_model: str = None) -> Dict:
    """
    主要路由函數：分析複雜度並調用適當模型
    """
    if force_model and force_model in MODELS:
        selected = force_model
    else:
        selected = analyze_complexity(message)
    
    model_config = MODELS[selected]
    model_name = model_config['name']
    
    print(f"🤖 Selected: {selected} ({model_name}) - Cost Level: {model_config['cost']}", file=sys.stderr)
    
    result = call_model(model_name, message, system_prompt)
    result['selected_tier'] = selected
    result['cost_level'] = model_config['cost']
    
    return result

def main():
    if len(sys.argv) < 2:
        print("Usage: ai_router.py '<message>' [system_prompt] [force_model]")
        sys.exit(1)
    
    message = sys.argv[1]
    system_prompt = sys.argv[2] if len(sys.argv) > 2 else None
    force_model = sys.argv[3] if len(sys.argv) > 3 else None
    
    result = route_and_call(message, system_prompt, force_model)
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}", file=sys.stderr)
        sys.exit(1)
    else:
        print(result['response'])

if __name__ == '__main__':
    main()