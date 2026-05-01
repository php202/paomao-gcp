#!/usr/bin/env python3
import json
import urllib.request
import time

SO_ID = 2004

# 廣告費用數據 (根據修正後的 Google Sheets)
ad_data = [
    ('F1 楠梓大學店', 16048, 2407.2, 802.4),
    ('J1 左營海軍店', 10785, 1617.75, 0),       # 特別：無服務費
    ('J2 台南東寧店', 12845, 1926.75, 0),       # 特別：無服務費  
    ('J3 內湖東湖店', 19336, 2900.4, 966.8),
    ('J4 雲林虎尾店', 15882, 2382.3, 794.1),
    ('J5 雲林斗六店', 17349, 2602.35, 867.45),
    ('J6 嘉義忠孝店', 14926, 2238.9, 746.3),
    ('J7 楊梅金山店', 19580, 2937, 979),
    ('J8 桃園八德店', 13494, 2024.1, 674.7),
    ('J9 桃園內壢店', 21707, 3256.05, 1085.35),
    ('J10 三峽大同店', 20057, 3008.55, 1002.85),
    ('J11 宜蘭站前店', 9291, 1393.65, 464.55),
    ('J12 羅東林森店', 7756, 1163.4, 387.8),
    ('J13 新莊中平店', 15789, 2368.35, 789.45),
    ('J14 頭份尚順店', 14313, 2146.95, 715.65),
    ('J15 彰化中興店', 12292, 1843.8, 614.6),
    ('J16 員林中山店', 19836, 2975.4, 991.8),
    ('J17 台南善化店', 9511, 1426.65, 475.55),
    ('J18 台南安南店', 9190, 1378.5, 459.5),
    ('J19 高雄前鎮店', 13904, 2085.6, 695.2),
    ('J20 高雄陽明店', 12678, 1901.7, 633.9)
]

def create_so_line(name, price):
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
                'sale.order.line',
                'create',
                [{
                    'order_id': SO_ID,
                    'name': name,
                    'product_uom_qty': 1.0,
                    'price_unit': price
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
        
        with urllib.request.urlopen(req, timeout=5) as response:
            result = json.loads(response.read().decode())
            if result.get('result'):
                return True
            else:
                print(f'❌ 失敗: {name} - {result}')
                return False
    except Exception as e:
        print(f'❌ 錯誤: {name} - {e}')
        return False

print(f'📝 為 SO {SO_ID} 新增明細行...')

line_count = 0
total_amount = 0

for store_name, ad_cost, handling_fee, service_fee in ad_data:
    print(f'\\n處理 {store_name}...')
    
    # 1. 廣告投遞費
    if ad_cost > 0:
        if create_so_line(f'廣告投遞\\n03月meta費', ad_cost):
            print(f'  ✅ 廣告費: NT$ {ad_cost:,.0f}')
            line_count += 1
            total_amount += ad_cost
        time.sleep(0.5)
    
    # 2. 手續費 15%
    if handling_fee > 0:
        if create_so_line(f'廣告費用\\n廣告手續費15%', handling_fee):
            print(f'  ✅ 手續費: NT$ {handling_fee:,.2f}')
            line_count += 1
            total_amount += handling_fee
        time.sleep(0.5)
    
    # 3. 服務費 5% (如果有)
    if service_fee > 0:
        if create_so_line(f'廣告費用\\n廣告投遞服務費 5%', service_fee):
            print(f'  ✅ 服務費: NT$ {service_fee:,.2f}')
            line_count += 1
            total_amount += service_fee
        time.sleep(0.5)
    elif service_fee == 0:
        print(f'  ⚠️  特殊門市：無服務費')

print(f'\\n🎉 SO 明細建立完成！')
print(f'📋 訂單 ID: {SO_ID}')
print(f'📊 明細行數: {line_count}')
print(f'💰 總金額: NT$ {total_amount:,.2f}')
print(f'🔗 連結: https://paomao.odoo.com/web#id={SO_ID}&model=sale.order&view_type=form')