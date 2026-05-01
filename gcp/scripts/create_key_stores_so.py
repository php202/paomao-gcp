#!/usr/bin/env python3
import json
import urllib.request
import time

# 已知的重要門市 Partner ID 和費用資訊
key_stores = {
    'F1 楠梓大學店': {'partner_id': 685, 'so_id': 2005, 'ad_cost': 16048, 'handling_fee': 2407.2, 'service_fee': 802.4},
    'J1 左營海軍店': {'partner_id': 17, 'so_id': 2006, 'ad_cost': 10785, 'handling_fee': 1617.75, 'service_fee': 0},
    'J2 台南東寧店': {'partner_id': 38, 'so_id': 2007, 'ad_cost': 12845, 'handling_fee': 1926.75, 'service_fee': 0},
    'J3 內湖東湖店': {'partner_id': 394, 'ad_cost': 19336, 'handling_fee': 2900.4, 'service_fee': 966.8},
}

def odoo_request(method, model, args):
    data = {
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {
            'service': 'object',
            'method': method,
            'args': ['paomao', 6, '6b89b5b178b3fc5dfef18e91645e82ce1b137ec3', model] + args
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
            return result.get('result')
    except Exception as e:
        print(f'❌ 錯誤: {e}')
        return None

def create_so_lines(so_id, store_name, ad_cost, handling_fee, service_fee):
    """為指定 SO 建立明細行"""
    lines_created = 0
    
    # 1. 廣告投遞費
    if ad_cost > 0:
        line_data = {
            'order_id': so_id,
            'name': '廣告投遞\\n03月meta費',
            'product_uom_qty': 1.0,
            'price_unit': ad_cost
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 廣告費: NT$ {ad_cost:,.0f}')
            lines_created += 1
        time.sleep(0.3)
    
    # 2. 手續費 15%
    if handling_fee > 0:
        line_data = {
            'order_id': so_id,
            'name': '廣告費用\\n廣告手續費15%',
            'product_uom_qty': 1.0,
            'price_unit': handling_fee
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 手續費: NT$ {handling_fee:,.2f}')
            lines_created += 1
        time.sleep(0.3)
    
    # 3. 服務費 5% (如果有)
    if service_fee > 0:
        line_data = {
            'order_id': so_id,
            'name': '廣告費用\\n廣告投遞服務費 5%',
            'product_uom_qty': 1.0,
            'price_unit': service_fee
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 服務費: NT$ {service_fee:,.2f}')
            lines_created += 1
        time.sleep(0.3)
    elif service_fee == 0:
        print(f'  ⚠️  特殊門市：無服務費')
    
    total = ad_cost + handling_fee + service_fee
    print(f'  💰 門市總額: NT$ {total:,.2f}')
    
    return lines_created

def create_new_so(partner_id, store_name):
    """建立新的 SO"""
    so_data = {
        'partner_id': partner_id,
        'date_order': '2026-04-26',
        'note': f'2025年3月份 Facebook 廣告代操費用 - {store_name}'
    }
    
    so_id = odoo_request('create', 'sale.order', [so_data])
    
    if so_id:
        print(f'✅ SO 建立成功: {so_id}')
        return so_id
    else:
        print(f'❌ SO 建立失敗: {store_name}')
        return None

print('🏪 處理重點門市的 SO 建立和明細行...')
print('=' * 60)

processed_stores = []

for store_name, store_info in key_stores.items():
    print(f'\\n📝 處理 {store_name}...')
    
    # 檢查是否已有 SO
    if 'so_id' in store_info:
        so_id = store_info['so_id']
        print(f'  使用現有 SO: {so_id}')
    else:
        # 建立新 SO
        so_id = create_new_so(store_info['partner_id'], store_name)
        if not so_id:
            continue
    
    # 建立明細行
    lines_count = create_so_lines(
        so_id, 
        store_name, 
        store_info['ad_cost'], 
        store_info['handling_fee'], 
        store_info['service_fee']
    )
    
    processed_stores.append({
        'store': store_name,
        'so_id': so_id,
        'lines': lines_count,
        'total': store_info['ad_cost'] + store_info['handling_fee'] + store_info['service_fee']
    })

print('\\n' + '=' * 60)
print('✅ 處理完成!')
print(f'📊 已處理 {len(processed_stores)} 家門市:')

total_amount = 0
for store in processed_stores:
    print(f"  • {store['store']}: SO {store['so_id']} ({store['lines']} 項, NT$ {store['total']:,.2f})")
    total_amount += store['total']

print(f'\\n💰 總計金額: NT$ {total_amount:,.2f}')
print('\\n📝 剩餘 17 家門市需要處理，需要繼續嗎？')