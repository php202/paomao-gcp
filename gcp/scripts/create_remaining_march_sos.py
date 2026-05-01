#!/usr/bin/env python3
import json
import urllib.request
import time

# 剩餘 18 家門市的資料 (根據 3月廣告 PDF)
stores_data = {
    'J3 內湖東湖店': {'partner_id': 394, 'ad_cost': 19336, 'handling_fee': 2900.4, 'service_fee': 966.8},
    'J4 雲林虎尾店': {'partner_id': 607, 'ad_cost': 15882, 'handling_fee': 2382.3, 'service_fee': 794.1}, 
    'J5 雲林斗六店': {'partner_id': 620, 'ad_cost': 17349, 'handling_fee': 2602.35, 'service_fee': 867.45},
    'J6 嘉義忠孝店': {'partner_id': 361, 'ad_cost': 14926, 'handling_fee': 2238.9, 'service_fee': 746.3},
    'J7 楊梅金山店': {'partner_id': 333, 'ad_cost': 19580, 'handling_fee': 2937, 'service_fee': 979},
    'J8 桃園八德店': {'partner_id': 73, 'ad_cost': 13494, 'handling_fee': 2024.1, 'service_fee': 674.7},
    'J9 桃園內壢店': {'partner_id': 15, 'ad_cost': 21707, 'handling_fee': 3256.05, 'service_fee': 1085.35},
    'J10 三峽大同店': {'partner_id': 415, 'ad_cost': 20057, 'handling_fee': 3008.55, 'service_fee': 1002.85},
    'J11 宜蘭站前店': {'partner_id': 84, 'ad_cost': 9291, 'handling_fee': 1393.65, 'service_fee': 464.55},
    'J12 羅東林森店': {'partner_id': 150, 'ad_cost': 7756, 'handling_fee': 1163.4, 'service_fee': 387.8},
    'J13 新莊中平店': {'partner_id': 104, 'ad_cost': 15789, 'handling_fee': 2368.35, 'service_fee': 789.45},
    'J14 頭份尚順店': {'partner_id': 613, 'ad_cost': 14313, 'handling_fee': 2146.95, 'service_fee': 715.65},
    'J15 彰化中興店': {'partner_id': 114, 'ad_cost': 12292, 'handling_fee': 1843.8, 'service_fee': 614.6},
    'J16 員林中山店': {'partner_id': 616, 'ad_cost': 19836, 'handling_fee': 2975.4, 'service_fee': 991.8},
    'J17 台南善化店': {'partner_id': 204, 'ad_cost': 9511, 'handling_fee': 1426.65, 'service_fee': 475.55},
    'J18 台南安南店': {'partner_id': None, 'ad_cost': 9190, 'handling_fee': 1378.5, 'service_fee': 459.5},  # Partner ID 待查詢
    'J19 高雄前鎮店': {'partner_id': 621, 'ad_cost': 13904, 'handling_fee': 2085.6, 'service_fee': 695.2},
    'J20 高雄陽明店': {'partner_id': 86, 'ad_cost': 12678, 'handling_fee': 1901.7, 'service_fee': 633.9},
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
        
        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.loads(response.read().decode())
            return result.get('result')
    except Exception as e:
        print(f'❌ 錯誤: {e}')
        return None

def create_store_so(store_name, partner_id, ad_cost, handling_fee, service_fee):
    """為門市建立 SO 和明細行"""
    print(f'\\n📝 建立 {store_name} SO...')
    
    if partner_id is None:
        print(f'❌ Partner ID 未知，跳過 {store_name}')
        return None
    
    # 建立 SO
    so_data = {
        'partner_id': partner_id,
        'company_id': 1,  # 明確指定泡泡貓股份有限公司
        'date_order': '2026-04-26',
        'note': f'2025年3月份 Facebook 廣告代操費用 - {store_name}'
    }
    
    so_id = odoo_request('create', 'sale.order', [so_data])
    if not so_id:
        print(f'❌ SO 建立失敗: {store_name}')
        return None
    
    print(f'✅ SO 建立成功: {so_id}')
    
    lines_created = 0
    
    # 1. 廣告投遞 (Product ID: 518)
    if ad_cost > 0:
        line_data = {
            'order_id': so_id,
            'product_id': 518,
            'company_id': 1,
            'name': '廣告投遞\\n2025年03月meta廣告投遞費',
            'product_uom_qty': 1.0,
            'price_unit': ad_cost
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 廣告投遞: NT$ {ad_cost:,.0f}')
            lines_created += 1
        time.sleep(0.2)
    
    # 2. 手續費 15% (Product ID: 456)
    if handling_fee > 0:
        line_data = {
            'order_id': so_id,
            'product_id': 456,
            'company_id': 1,
            'name': '廣告費用\\n廣告手續費15%',
            'product_uom_qty': 1.0,
            'price_unit': handling_fee
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 廣告手續費15%: NT$ {handling_fee:,.2f}')
            lines_created += 1
        time.sleep(0.2)
    
    # 3. 服務費 5% (Product ID: 456)
    if service_fee > 0:
        line_data = {
            'order_id': so_id,
            'product_id': 456,
            'company_id': 1,
            'name': '廣告費用\\n廣告投遞服務費5%',
            'product_uom_qty': 1.0,
            'price_unit': service_fee
        }
        if odoo_request('create', 'sale.order.line', [line_data]):
            print(f'  ✅ 廣告投遞服務費5%: NT$ {service_fee:,.2f}')
            lines_created += 1
        time.sleep(0.2)
    
    total = ad_cost + handling_fee + service_fee
    print(f'  💰 門市總額: NT$ {total:,.2f}')
    print(f'  🔗 https://paomao.odoo.com/web#id={so_id}&model=sale.order&view_type=form')
    
    return so_id, lines_created, total

if __name__ == '__main__':
    print('🏪 建立剩餘 18 家門市的 3月廣告費用 SO...')
    print('=' * 70)
    
    created_sos = []
    skipped_stores = []
    total_amount = 0
    
    for store_name, store_info in stores_data.items():
        if store_info['partner_id'] is None:
            print(f'❓ {store_name}: Partner ID 待查詢，跳過')
            skipped_stores.append(store_name)
            continue
        
        result = create_store_so(
            store_name,
            store_info['partner_id'],
            store_info['ad_cost'],
            store_info['handling_fee'],
            store_info['service_fee']
        )
        
        if result:
            so_id, lines_count, total = result
            created_sos.append({
                'store': store_name,
                'so_id': so_id,
                'lines': lines_count,
                'total': total
            })
            total_amount += total
        
        # 避免 API 限制
        time.sleep(0.5)
    
    print('\\n' + '=' * 70)
    print('✅ 處理完成!')
    print(f'📊 新建立 {len(created_sos)} 家門市 SO:')
    
    for store in created_sos:
        print(f"  • {store['store']}: SO {store['so_id']} ({store['lines']} 項, NT$ {store['total']:,.2f})")
    
    if skipped_stores:
        print(f'\\n❓ Partner ID 待查詢: {len(skipped_stores)} 家')
        for store in skipped_stores:
            print(f'  • {store}')
    
    print(f'\\n💰 新建立總計: NT$ {total_amount:,.2f}')
    print(f'🎯 與已完成 3 家合計: NT$ {total_amount + 44069.1:,.2f}')
    
    print('\\n✅ 所有 SO 使用:')
    print('  • Product ID 518: 廣告投遞')
    print('  • Product ID 456: 廣告費用 (手續費/服務費)')
    print('  • Company ID 1: 泡泡貓股份有限公司')
    print('  • 無稅項設定')