#!/bin/bash

echo "🏪 批次建立剩餘門市 3月廣告費用 SO..."
echo "========================================================"

# 門市資料 (格式: 門市名稱|Partner_ID|廣告費|手續費|服務費)
stores=(
  "J5 雲林斗六店|620|17349|2602.35|867.45"
  "J6 嘉義忠孝店|361|14926|2238.9|746.3"
  "J7 楊梅金山店|333|19580|2937|979"
  "J8 桃園八德店|73|13494|2024.1|674.7"
  "J9 桃園內壢店|15|21707|3256.05|1085.35"
  "J10 三峽大同店|415|20057|3008.55|1002.85"
  "J11 宜蘭站前店|84|9291|1393.65|464.55"
  "J12 羅東林森店|150|7756|1163.4|387.8"
  "J13 新莊中平店|104|15789|2368.35|789.45"
  "J14 頭份尚順店|613|14313|2146.95|715.65"
  "J15 彰化中興店|114|12292|1843.8|614.6"
  "J16 員林中山店|616|19836|2975.4|991.8"
  "J17 台南善化店|204|9511|1426.65|475.55"
  "J19 高雄前鎮店|621|13904|2085.6|695.2"
  "J20 高雄陽明店|86|12678|1901.7|633.9"
)

create_so_with_lines() {
  local store_name="$1"
  local partner_id="$2"
  local ad_cost="$3"
  local handling_fee="$4"
  local service_fee="$5"
  
  echo ""
  echo "📝 建立 $store_name..."
  
  # 建立 SO
  local so_id=$(curl -s -X POST "https://paomao.odoo.com/jsonrpc" \
    -H "Content-Type: application/json" \
    -d '{
      "jsonrpc": "2.0",
      "method": "call",
      "params": {
        "service": "object",
        "method": "execute_kw",
        "args": [
          "paomao", 6, "6b89b5b178b3fc5dfef18e91645e82ce1b137ec3",
          "sale.order", "create",
          [{
            "partner_id": '$partner_id',
            "company_id": 1,
            "date_order": "2026-04-26",
            "note": "2025年3月份 Facebook 廣告代操費用 - '$store_name'"
          }]
        ]
      },
      "id": 1
    }' | jq -r '.result')
  
  if [[ "$so_id" =~ ^[0-9]+$ ]]; then
    echo "  ✅ SO $so_id 建立成功"
    
    # 建立廣告投遞明細行
    curl -s -X POST "https://paomao.odoo.com/jsonrpc" \
      -H "Content-Type: application/json" \
      -d '{
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
          "service": "object",
          "method": "execute_kw",
          "args": [
            "paomao", 6, "6b89b5b178b3fc5dfef18e91645e82ce1b137ec3",
            "sale.order.line", "create",
            [{
              "order_id": '$so_id',
              "product_id": 518,
              "company_id": 1,
              "name": "廣告投遞\\n2025年03月meta廣告投遞費",
              "product_uom_qty": 1.0,
              "price_unit": '$ad_cost'
            }]
          ]
        },
        "id": 1
      }' > /dev/null && echo "    ✅ 廣告投遞: NT$ $ad_cost"
    
    # 建立手續費明細行
    curl -s -X POST "https://paomao.odoo.com/jsonrpc" \
      -H "Content-Type: application/json" \
      -d '{
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
          "service": "object",
          "method": "execute_kw",
          "args": [
            "paomao", 6, "6b89b5b178b3fc5dfef18e91645e82ce1b137ec3",
            "sale.order.line", "create",
            [{
              "order_id": '$so_id',
              "product_id": 456,
              "company_id": 1,
              "name": "廣告費用\\n廣告手續費15%",
              "product_uom_qty": 1.0,
              "price_unit": '$handling_fee'
            }]
          ]
        },
        "id": 1
      }' > /dev/null && echo "    ✅ 手續費15%: NT$ $handling_fee"
    
    # 建立服務費明細行
    curl -s -X POST "https://paomao.odoo.com/jsonrpc" \
      -H "Content-Type: application/json" \
      -d '{
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
          "service": "object",
          "method": "execute_kw",
          "args": [
            "paomao", 6, "6b89b5b178b3fc5dfef18e91645e82ce1b137ec3",
            "sale.order.line", "create",
            [{
              "order_id": '$so_id',
              "product_id": 456,
              "company_id": 1,
              "name": "廣告費用\\n廣告投遞服務費5%",
              "product_uom_qty": 1.0,
              "price_unit": '$service_fee'
            }]
          ]
        },
        "id": 1
      }' > /dev/null && echo "    ✅ 服務費5%: NT$ $service_fee"
    
    local total=$(echo "$ad_cost + $handling_fee + $service_fee" | bc)
    echo "    💰 門市總額: NT$ $total"
    echo "    🔗 https://paomao.odoo.com/web#id=$so_id&model=sale.order&view_type=form"
    
    echo "$store_name|$so_id|$total" >> /tmp/created_sos.txt
  else
    echo "  ❌ SO 建立失敗: $store_name"
  fi
  
  sleep 0.5
}

# 清空結果檔案
> /tmp/created_sos.txt

# 建立所有門市的 SO
for store_data in "${stores[@]}"; do
  IFS='|' read -r store_name partner_id ad_cost handling_fee service_fee <<< "$store_data"
  create_so_with_lines "$store_name" "$partner_id" "$ad_cost" "$handling_fee" "$service_fee"
done

echo ""
echo "========================================================"
echo "✅ 批次建立完成！"
echo ""

if [[ -f /tmp/created_sos.txt ]]; then
  echo "📊 建立成功的門市:"
  total_amount=0
  while IFS='|' read -r store so_id amount; do
    echo "  • $store: SO $so_id (NT$ $amount)"
    total_amount=$(echo "$total_amount + $amount" | bc)
  done < /tmp/created_sos.txt
  
  echo ""
  echo "💰 新建立總計: NT$ $total_amount"
  echo "🎯 含已完成 5 家合計: NT$ $(echo "$total_amount + 44069.1 + 23203.2 + 19058.4" | bc)"
fi

echo ""
echo "✅ 所有 SO 規格:"
echo "  • Product ID 518: 廣告投遞"
echo "  • Product ID 456: 廣告費用 (手續費/服務費)"  
echo "  • Company ID 1: 泡泡貓股份有限公司"
echo "  • 無稅項設定"