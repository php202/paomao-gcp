#!/usr/bin/env python3
import json
import urllib.request

# 廣告費用數據 (21家門市)
stores_data = {
    'F1 楠梓大學店': {'ad_cost': 16048, 'handling_fee': 2407.2, 'service_fee': 802.4},
    'J1 左營海軍店': {'ad_cost': 10785, 'handling_fee': 1617.75, 'service_fee': 0},  # 特殊
    'J2 台南東寧店': {'ad_cost': 12845, 'handling_fee': 1926.75, 'service_fee': 0},  # 特殊
    'J3 內湖東湖店': {'ad_cost': 19336, 'handling_fee': 2900.4, 'service_fee': 966.8},
    'J4 雲林虎尾店': {'ad_cost': 15882, 'handling_fee': 2382.3, 'service_fee': 794.1},
    'J5 雲林斗六店': {'ad_cost': 17349, 'handling_fee': 2602.35, 'service_fee': 867.45},
    'J6 嘉義忠孝店': {'ad_cost': 14926, 'handling_fee': 2238.9, 'service_fee': 746.3},
    'J7 楊梅金山店': {'ad_cost': 19580, 'handling_fee': 2937, 'service_fee': 979},
    'J8 桃園八德店': {'ad_cost': 13494, 'handling_fee': 2024.1, 'service_fee': 674.7},
    'J9 桃園內壢店': {'ad_cost': 21707, 'handling_fee': 3256.05, 'service_fee': 1085.35},
    'J10 三峽大同店': {'ad_cost': 20057, 'handling_fee': 3008.55, 'service_fee': 1002.85},
    'J11 宜蘭站前店': {'ad_cost': 9291, 'handling_fee': 1393.65, 'service_fee': 464.55},
    'J12 羅東林森店': {'ad_cost': 7756, 'handling_fee': 1163.4, 'service_fee': 387.8},
    'J13 新莊中平店': {'ad_cost': 15789, 'handling_fee': 2368.35, 'service_fee': 789.45},
    'J14 頭份尚順店': {'ad_cost': 14313, 'handling_fee': 2146.95, 'service_fee': 715.65},
    'J15 彰化中興店': {'ad_cost': 12292, 'handling_fee': 1843.8, 'service_fee': 614.6},
    'J16 員林中山店': {'ad_cost': 19836, 'handling_fee': 2975.4, 'service_fee': 991.8},
    'J17 台南善化店': {'ad_cost': 9511, 'handling_fee': 1426.65, 'service_fee': 475.55},
    'J18 台南安南店': {'ad_cost': 9190, 'handling_fee': 1378.5, 'service_fee': 459.5},
    'J19 高雄前鎮店': {'ad_cost': 13904, 'handling_fee': 2085.6, 'service_fee': 695.2},
    'J20 高雄陽明店': {'ad_cost': 12678, 'handling_fee': 1901.7, 'service_fee': 633.9}
}

# 門市關鍵字對應
store_keywords = {
    'F1 楠梓大學店': ['楠梓'],
    'J1 左營海軍店': ['左營', '海軍'],
    'J2 台南東寧店': ['東寧'],
    'J3 內湖東湖店': ['內湖', '東湖'],
    'J4 雲林虎尾店': ['虎尾'],
    'J5 雲林斗六店': ['斗六'],
    'J6 嘉義忠孝店': ['忠孝'],
    'J7 楊梅金山店': ['楊梅', '金山'],
    'J8 桃園八德店': ['八德'],
    'J9 桃園內壢店': ['內壢'],
    'J10 三峽大同店': ['三峽', '大同'],
    'J11 宜蘭站前店': ['宜蘭', '站前'],
    'J12 羅東林森店': ['羅東', '林森'],
    'J13 新莊中平店': ['新莊', '中平'],
    'J14 頭份尚順店': ['頭份', '尚順'],
    'J15 彰化中興店': ['彰化', '中興'],
    'J16 員林中山店': ['員林', '中山'],
    'J17 台南善化店': ['善化'],
    'J18 台南安南店': ['安南'],
    'J19 高雄前鎮店': ['前鎮'],
    'J20 高雄陽明店': ['陽明']
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
        print(f'❌ 查詢錯誤: {e}')
        return None

def find_partner_by_keywords(keywords):
    for keyword in keywords:
        result = odoo_request('search_read', 'res.partner', [
            [['name', 'ilike', keyword]],
            {'fields': ['id', 'name'], 'limit': 10}
        ])
        
        if result:
            for partner in result:
                name = partner['name']
                if '泡泡貓' in name and '店' in name:
                    return partner['id'], name
    
    return None, None

print('🔍 查詢所有門市的 Partner ID...')
print('=' * 80)

found_partners = {}
missing_stores = []

for store_name, keywords in store_keywords.items():
    partner_id, partner_name = find_partner_by_keywords(keywords)
    
    if partner_id:
        found_partners[store_name] = {'partner_id': partner_id, 'partner_name': partner_name}
        print(f'✅ {store_name:<20} → ID: {partner_id:<4} ({partner_name})')
    else:
        missing_stores.append(store_name)
        print(f'❌ {store_name:<20} → 找不到對應的 Partner')

print('=' * 80)
print(f'📊 統計: 找到 {len(found_partners)} 家，缺失 {len(missing_stores)} 家')

if missing_stores:
    print(f'❌ 缺失門市: {", ".join(missing_stores)}')

# 產生完整的門市對應表
print('\\n📋 完整門市對應表:')
print('store_partner_mapping = {')
for store_name in stores_data.keys():
    if store_name in found_partners:
        partner_info = found_partners[store_name]
        store_info = stores_data[store_name]
        print(f"    '{store_name}': {{'partner_id': {partner_info['partner_id']}, 'ad_cost': {store_info['ad_cost']}, 'handling_fee': {store_info['handling_fee']}, 'service_fee': {store_info['service_fee']}}},")
    else:
        print(f"    # '{store_name}': {{'partner_id': ???, ...}},  # 找不到")
print('}')