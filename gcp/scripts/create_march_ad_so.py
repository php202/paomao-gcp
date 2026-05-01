#!/usr/bin/env python3
import json
import urllib.request
import urllib.parse

# Odoo 配置
ODOO_URL = 'https://paomao.odoo.com'
ODOO_DB = 'paomao'
ODOO_USER = 'php202@gmail.com'
ODOO_PASS = '6b89b5b178b3fc5dfef18e91645e82ce1b137ec3'
UID = 6

def odoo_request(method, model, args):
    data = {
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {
            'service': 'object',
            'method': method,
            'args': [ODOO_DB, UID, ODOO_PASS, model] + args
        },
        'id': 1
    }
    
    req = urllib.request.Request(
        f'{ODOO_URL}/jsonrpc',
        data=json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'}
    )
    
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode())
        return result.get('result')

print('📝 建立 3 月廣告費用 SO...')

# 建立 SO
so_data = {
    'partner_id': 187,  # 泡泡貓公司 ID
    'date_order': '2026-04-26',
    'note': '2025年3月份 Facebook 廣告代操費用'
}

so_id = odoo_request('create', 'sale.order', [so_data])
print(f'✅ SO 建立成功, ID: {so_id}')

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

line_count = 0

# 建立 SO 明細
for store_name, ad_cost, handling_fee, service_fee in ad_data:
    # 1. 廣告投遞費
    if ad_cost > 0:
        line_data = {
            'order_id': so_id,
            'name': f'廣告投遞\n03月meta費',
            'product_uom_qty': 1.0,
            'price_unit': ad_cost
        }
        odoo_request('create', 'sale.order.line', [line_data])
        line_count += 1
    
    # 2. 手續費 15%
    if handling_fee > 0:
        line_data = {
            'order_id': so_id,
            'name': f'廣告費用\n廣告手續費15%',
            'product_uom_qty': 1.0,
            'price_unit': handling_fee
        }
        odoo_request('create', 'sale.order.line', [line_data])
        line_count += 1
    
    # 3. 服務費 5% (如果有)
    if service_fee > 0:
        line_data = {
            'order_id': so_id,
            'name': f'廣告費用\n廣告投遞服務費 5%',
            'product_uom_qty': 1.0,
            'price_unit': service_fee
        }
        odoo_request('create', 'sale.order.line', [line_data])
        line_count += 1
    
    print(f'✅ {store_name} 已加入 ({1 + (1 if handling_fee > 0 else 0) + (1 if service_fee > 0 else 0)} 項)')

print(f'\n🎉 SO 建立完成！')
print(f'📋 訂單 ID: {so_id}')
print(f'📊 明細行數: {line_count}')
print(f'🔗 連結: https://paomao.odoo.com/web#id={so_id}&model=sale.order&view_type=form')
print(f'\n📝 特殊處理:')
print(f'  • J1 左營海軍店: 廣告費 + 手續費 (無服務費)')
print(f'  • J2 台南東寧店: 廣告費 + 手續費 (無服務費)')

# 計算總金額
total_ad = sum(item[1] for item in ad_data)
total_handling = sum(item[2] for item in ad_data)
total_service = sum(item[3] for item in ad_data)
grand_total = total_ad + total_handling + total_service

print(f'\n💰 費用統計:')
print(f'  • 廣告費總計: NT$ {total_ad:,.0f}')
print(f'  • 手續費總計: NT$ {total_handling:,.2f}')
print(f'  • 服務費總計: NT$ {total_service:,.2f}')
print(f'  • 總金額: NT$ {grand_total:,.2f}')