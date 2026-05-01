#!/bin/bash

SO_ID=2004
BASE_URL="https://paomao.odoo.com/jsonrpc"
DB="paomao"
USER_ID="6"
PASS="6b89b5b178b3fc5dfef18e91645e82ce1b137ec3"

# 函數：建立明細行
create_line() {
    local name="$1"
    local price="$2"
    
    result=$(curl -s -X POST "$BASE_URL" \
      -H "Content-Type: application/json" \
      -d '{
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
          "service": "object",
          "method": "execute_kw",
          "args": [
            "'$DB'",
            '$USER_ID',
            "'$PASS'",
            "sale.order.line",
            "create",
            [{
              "order_id": '$SO_ID',
              "name": "'"$name"'",
              "product_uom_qty": 1.0,
              "price_unit": '$price'
            }]
          ]
        },
        "id": 1
      }' | jq -r '.result')
    
    if [ "$result" != "null" ] && [ -n "$result" ]; then
        return 0
    else
        return 1
    fi
}

echo "📝 完成剩餘 18 家門市的 SO $SO_ID 明細行..."

# J3 內湖東湖店
echo "處理 J3 內湖東湖店..."
create_line "廣告投遞\\n03月meta費" 19336
create_line "廣告費用\\n廣告手續費15%" 2900.4
create_line "廣告費用\\n廣告投遞服務費 5%" 966.8
echo "✅ J3 完成"

# J4 雲林虎尾店  
echo "處理 J4 雲林虎尾店..."
create_line "廣告投遞\\n03月meta費" 15882
create_line "廣告費用\\n廣告手續費15%" 2382.3
create_line "廣告費用\\n廣告投遞服務費 5%" 794.1
echo "✅ J4 完成"

# J5 雲林斗六店
echo "處理 J5 雲林斗六店..."
create_line "廣告投遞\\n03月meta費" 17349
create_line "廣告費用\\n廣告手續費15%" 2602.35
create_line "廣告費用\\n廣告投遞服務費 5%" 867.45
echo "✅ J5 完成"

# J6 嘉義忠孝店
echo "處理 J6 嘉義忠孝店..."
create_line "廣告投遞\\n03月meta費" 14926
create_line "廣告費用\\n廣告手續費15%" 2238.9
create_line "廣告費用\\n廣告投遞服務費 5%" 746.3
echo "✅ J6 完成"

# J7 楊梅金山店
echo "處理 J7 楊梅金山店..."
create_line "廣告投遞\\n03月meta費" 19580
create_line "廣告費用\\n廣告手續費15%" 2937
create_line "廣告費用\\n廣告投遞服務費 5%" 979
echo "✅ J7 完成"

# J8 桃園八德店
echo "處理 J8 桃園八德店..."
create_line "廣告投遞\\n03月meta費" 13494
create_line "廣告費用\\n廣告手續費15%" 2024.1
create_line "廣告費用\\n廣告投遞服務費 5%" 674.7
echo "✅ J8 完成"

# J9 桃園內壢店
echo "處理 J9 桃園內壢店..."
create_line "廣告投遞\\n03月meta費" 21707
create_line "廣告費用\\n廣告手續費15%" 3256.05
create_line "廣告費用\\n廣告投遞服務費 5%" 1085.35
echo "✅ J9 完成"

# J10 三峽大同店
echo "處理 J10 三峽大同店..."
create_line "廣告投遞\\n03月meta費" 20057
create_line "廣告費用\\n廣告手續費15%" 3008.55
create_line "廣告費用\\n廣告投遞服務費 5%" 1002.85
echo "✅ J10 完成"

# J11 宜蘭站前店
echo "處理 J11 宜蘭站前店..."
create_line "廣告投遞\\n03月meta費" 9291
create_line "廣告費用\\n廣告手續費15%" 1393.65
create_line "廣告費用\\n廣告投遞服務費 5%" 464.55
echo "✅ J11 完成"

# J12 羅東林森店
echo "處理 J12 羅東林森店..."
create_line "廣告投遞\\n03月meta費" 7756
create_line "廣告費用\\n廣告手續費15%" 1163.4
create_line "廣告費用\\n廣告投遞服務費 5%" 387.8
echo "✅ J12 完成"

# J13 新莊中平店
echo "處理 J13 新莊中平店..."
create_line "廣告投遞\\n03月meta費" 15789
create_line "廣告費用\\n廣告手續費15%" 2368.35
create_line "廣告費用\\n廣告投遞服務費 5%" 789.45
echo "✅ J13 完成"

# J14 頭份尚順店
echo "處理 J14 頭份尚順店..."
create_line "廣告投遞\\n03月meta費" 14313
create_line "廣告費用\\n廣告手續費15%" 2146.95
create_line "廣告費用\\n廣告投遞服務費 5%" 715.65
echo "✅ J14 完成"

# J15 彰化中興店
echo "處理 J15 彰化中興店..."
create_line "廣告投遞\\n03月meta費" 12292
create_line "廣告費用\\n廣告手續費15%" 1843.8
create_line "廣告費用\\n廣告投遞服務費 5%" 614.6
echo "✅ J15 完成"

# J16 員林中山店
echo "處理 J16 員林中山店..."
create_line "廣告投遞\\n03月meta費" 19836
create_line "廣告費用\\n廣告手續費15%" 2975.4
create_line "廣告費用\\n廣告投遞服務費 5%" 991.8
echo "✅ J16 完成"

# J17 台南善化店
echo "處理 J17 台南善化店..."
create_line "廣告投遞\\n03月meta費" 9511
create_line "廣告費用\\n廣告手續費15%" 1426.65
create_line "廣告費用\\n廣告投遞服務費 5%" 475.55
echo "✅ J17 完成"

# J18 台南安南店
echo "處理 J18 台南安南店..."
create_line "廣告投遞\\n03月meta費" 9190
create_line "廣告費用\\n廣告手續費15%" 1378.5
create_line "廣告費用\\n廣告投遞服務費 5%" 459.5
echo "✅ J18 完成"

# J19 高雄前鎮店
echo "處理 J19 高雄前鎮店..."
create_line "廣告投遞\\n03月meta費" 13904
create_line "廣告費用\\n廣告手續費15%" 2085.6
create_line "廣告費用\\n廣告投遞服務費 5%" 695.2
echo "✅ J19 完成"

# J20 高雄陽明店
echo "處理 J20 高雄陽明店..."
create_line "廣告投遞\\n03月meta費" 12678
create_line "廣告費用\\n廣告手續費15%" 1901.7
create_line "廣告費用\\n廣告投遞服務費 5%" 633.9
echo "✅ J20 完成"

echo ""
echo "🎉 全部 21 家門市處理完成！"
echo "📋 SO ID: $SO_ID"
echo "💰 總計 63 筆明細行 (21家 × 3項 = 63筆)"
echo "🔗 檢查: https://paomao.odoo.com/web#id=$SO_ID&model=sale.order&view_type=form"