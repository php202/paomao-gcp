#!/usr/bin/env python3
import json
import urllib.request
import time

# Odoo 配置
ODOO_URL = 'https://paomao.odoo.com'
ODOO_DB = 'paomao'
UID = 6
PASS = '6b89b5b178b3fc5dfef18e91645e82ce1b137ec3'

# 門市對應 (根據剛查詢的結果手動整理)
store_mapping = {
    'F1 楠梓大學店': {'partner_id': 685, 'ad_cost': 16048, 'handling_fee': 2407.2, 'service_fee': 802.4},
    'J1 左營海軍店': {'partner_id': 17, 'ad_cost': 10785, 'handling_fee': 1617.75, 'service_fee': 0},  # 特殊
    'J2 台南東寧店': {'partner_id': 38, 'ad_cost': 12845, 'handling_fee': 1926.75, 'service_fee': 0},  # 特殊
    'J3 內湖東湖店': {'partner_id': 394, 'ad_cost': 19336, 'handling_fee': 2900.4, 'service_fee': 966.8},
    # 需要查詢更多門市 ID...
}

def odoo_request(method, model, args):
    data = {
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {
            'service': 'object',
            'method': method,
            'args': [ODOO_DB, UID, PASS, model] + args
        },
        'id': 1
    }
    
    try:
        req = urllib.request.Request(
            f'{ODOO_URL}/jsonrpc',
            data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode())
            return result.get('result')
    except Exception as e:
        print(f'❌ 請求錯誤: {e}')
        return None

def find_store_partner_id(store_keyword):
    """查詢門市的 partner ID"""
    result = odoo_request('search_read', 'res.partner', [
        [['name', 'ilike', store_keyword]],
        {'fields': ['id', 'name'], 'limit': 5}
    ])
    
    if result:
        for partner in result:
            if '店' in partner['name'] and store_keyword in partner['name']:
                return partner['id'], partner['name']
    
    return None, None

def create_store_so(partner_id, store_name, ad_cost, handling_fee, service_fee):
    """為單一門市建立 SO"""
    print(f'\\n📝 為 {store_name} 建立 SO...')
    
    # 建立 SO
    so_data = {
        'partner_id': partner_id,
        'date_order': '2026-04-26',
        'note': f'2025年3月份 Facebook 廣告代操費用 - {store_name}'
    }
    
    so_id = odoo_request('create', 'sale.order', [so_data])
    
    if not so_id:
        print(f'❌ SO 建立失敗: {store_name}')
        return None
    
    print(f'✅ SO 建立成功: {so_id}')
    
    # 建立明細行
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
            lines_created += 1
        time.sleep(0.3)
    
    total_amount = ad_cost + handling_fee + service_fee
    print(f'  明細: {lines_created} 項，總額 NT$ {total_amount:,.2f}')
    
    return so_id

if __name__ == '__main__':
    print('🏪 為各門市分別建立 3月廣告費用 SO...')
    
    # 先處理已知的前3家
    known_stores = [
        ('楠梓', 685, 'F1 楠梓大學店', 16048, 2407.2, 802.4),
        ('左營', 17, 'J1 左營海軍店', 10785, 1617.75, 0),
        ('東寧', 38, 'J2 台南東寧店', 12845, 1926.75, 0),
    ]
    
    created_sos = []
    
    for keyword, partner_id, store_name, ad_cost, handling_fee, service_fee in known_stores:
        so_id = create_store_so(partner_id, store_name, ad_cost, handling_fee, service_fee)
        if so_id:
            created_sos.append((store_name, so_id))
    
    print(f'\\n✅ 已建立 {len(created_sos)} 個門市 SO:')
    for store_name, so_id in created_sos:
        print(f'  • {store_name}: SO {so_id}')
    
    print('\\n💡 需要繼續建立其他 18 家門市嗎？')