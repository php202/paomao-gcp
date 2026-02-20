#!/usr/bin/env bash
# Cloud Run 固定出口 IP：建立靜態 IP、Cloud Router、Cloud NAT，並輸出 IP 供 Giveme 白名單使用
# 使用前：source ../set-env.sh（或 export PROJECT_ID, REGION）
# 執行：./scripts/setup-static-egress.sh

set -e
cd "$(dirname "$0")/.."
[ -f set-env.sh ] && source set-env.sh

: "${PROJECT_ID:?請設定 PROJECT_ID（可 source set-env.sh）}"
: "${REGION:=asia-east1}"

# 資源名稱（可改）
ADDR_NAME="${EGRESS_IP_NAME:-pao-run-egress-ip}"
ROUTER_NAME="${EGRESS_ROUTER_NAME:-pao-run-router}"
NAT_NAME="${EGRESS_NAT_NAME:-pao-run-nat}"
NETWORK="${EGRESS_NETWORK:-default}"

# default VPC 在 asia-east1 的 subnet 通常叫 default
SUBNET="${EGRESS_SUBNET:-default}"

echo "=== 1. 預留靜態 IP（若已存在則略過）==="
if gcloud compute addresses describe "$ADDR_NAME" --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  echo "靜態 IP 資源已存在: $ADDR_NAME"
else
  gcloud compute addresses create "$ADDR_NAME" --region="$REGION" --project="$PROJECT_ID"
fi

STATIC_IP=$(gcloud compute addresses describe "$ADDR_NAME" --region="$REGION" --project="$PROJECT_ID" --format='get(address)')
echo "固定出口 IP: $STATIC_IP  （請將此 IP 填入 Giveme 白名單）"

echo ""
echo "=== 2. 建立 Cloud Router（若已存在則略過）==="
if gcloud compute routers describe "$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  echo "Router 已存在: $ROUTER_NAME"
else
  gcloud compute routers create "$ROUTER_NAME" \
    --network="$NETWORK" \
    --region="$REGION" \
    --project="$PROJECT_ID"
fi

echo ""
echo "=== 3. 建立 Cloud NAT（若已存在則略過）==="
if gcloud compute routers nats describe "$NAT_NAME" --router="$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  echo "NAT 已存在: $NAT_NAME"
else
  gcloud compute routers nats create "$NAT_NAME" \
    --router="$ROUTER_NAME" \
    --region="$REGION" \
    --nat-custom-subnet-ip-ranges="$SUBNET" \
    --nat-external-ip-pool="$ADDR_NAME" \
    --project="$PROJECT_ID"
fi

echo ""
echo "=== 完成 ==="
echo "固定出口 IP: $STATIC_IP"
echo "請在 Giveme 後台白名單加入此 IP。"
echo ""
echo "接下來請讓 Cloud Run 走 VPC："
echo "  方式 A) 在 deploy-line-webhook.sh 執行前設定："
echo "    export EGRESS_NETWORK=default EGRESS_SUBNET=default"
echo "  並確認 deploy-line-webhook.sh 已支援這兩個變數（會傳給 gcloud run deploy）。"
echo "  方式 B) 到 Console → Cloud Run → pao-checkin-api → 編輯與部署新修訂版本"
echo "    → Connections → Direct VPC egress → Network=default, Subnet=default, 流量=全部經 VPC。"
