#!/bin/bash

SO_ID=2004
BASE_URL="https://paomao.odoo.com/jsonrpc"
DB="paomao"
UID="6"
PASS="6b89b5b178b3fc5dfef18e91645e82ce1b137ec3"

# 函數：建立明細行
create_line() {
    local name="$1"
    local price="$2"
    
    curl -s -X POST "$BASE_URL" \
      -H "Content-Type: application/json" \
      -d '{
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
          "service": "object",
          "method": "execute_kw",
          "args": [
            "'$DB'",
            '$UID',
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
      }' | jq -r '.result'
}

echo "📝 批量建立 SO $SO_ID 明細行..."

# F1 楠梓大學店
echo "處理 F1 楠梓大學店..."
create_line "廣告費用\\n廣告手續費15%" 2407.2 >/dev/null
create_line "廣告費用\\n廣告投遞服務費 5%" 802.4 >/dev/null
echo "✅ F1 完成"

# J1 左營海軍店 (無服務費)
echo "處理 J1 左營海軍店..."
create_line "廣告投遞\\n03月meta費" 10785 >/dev/null
create_line "廣告費用\\n廣告手續費15%" 1617.75 >/dev/null
echo "✅ J1 完成 (無服務費)"

# J2 台南東寧店 (無服務費)
echo "處理 J2 台南東寧店..."
create_line "廣告投遞\\n03月meta費" 12845 >/dev/null
create_line "廣告費用\\n廣告手續費15%" 1926.75 >/dev/null
echo "✅ J2 完成 (無服務費)"

echo ""
echo "🎉 前 3 家門市處理完成！"
echo "🔗 請檢查: https://paomao.odoo.com/web#id=$SO_ID&model=sale.order&view_type=form"
echo ""
echo "💡 如需繼續處理其他 18 家門市，請告知"