#!/usr/bin/env python3
import json
import urllib.request
import time

def create_so():
    data = {
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {
            'service': 'object',
            'method': 'execute_kw',
            'args': [
                'paomao',
                6,
                '6b89b5b178b3fc5dfef18e91645e82ce1b137ec3',
                'sale.order',
                'create',
                [{
                    'partner_id': 187,
                    'date_order': '2026-04-26',
                    'note': '2025年3月份 Facebook 廣告代操費用'
                }]
            ]
        },
        'id': 1
    }
    
    try:
        req = urllib.request.Request(
            'https://paomao.odoo.com/jsonrpc',
            data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode())
            so_id = result.get('result')
            if so_id:
                print(f'✅ SO 建立成功, ID: {so_id}')
                print(f'🔗 連結: https://paomao.odoo.com/web#id={so_id}&model=sale.order&view_type=form')
                return so_id
            else:
                print(f'❌ 建立失敗: {result}')
                return None
    except Exception as e:
        print(f'❌ 連線錯誤: {e}')
        return None

if __name__ == '__main__':
    create_so()