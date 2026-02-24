#!/usr/bin/env bash
# 重新建映像並部署 pao-checkin-api，讓服務包含 /line-webhook（LINE Webhook 備援）
# 使用前：source set-env.sh，並設定 LINE_CHANNEL_SECRET、LINE_TOKEN_PAOSTAFF（勿提交到版控）
# 執行：./deploy-line-webhook.sh

set -e
cd "$(dirname "$0")"
[ -f set-env.sh ] && source set-env.sh

: "${PROJECT_ID:?請設定 PROJECT_ID（可 source set-env.sh）}"
: "${REGION:=asia-east1}"
: "${LINE_STAFF_SS_ID:?請設定 LINE_STAFF_SS_ID（可 source set-env.sh）}"
: "${LINE_CHANNEL_SECRET:?請先 export LINE_CHANNEL_SECRET}"
: "${LINE_TOKEN_PAOSTAFF:?請先 export LINE_TOKEN_PAOSTAFF}"

# 選填：若未提供，沿用目前 Cloud Run 既有值或程式預設
: "${LINE_HQ_SS_ID:=}"
: "${LINE_STORE_SS_ID:=}"
: "${PAO_CAT_CORE_API_URL:=}"
: "${PAO_CAT_SECRET_KEY:=}"
: "${LEGACY_GAS_CORE_API_URL:=}"
: "${LEGACY_GAS_STORES_API_URL:=}"
: "${INTEGRATED_SHEET_SS_ID:=}"
: "${ADMIN_KEY:=}"
: "${PAOPAO_STORE_SS_ID:=}"
: "${LINE_CHANNEL_SECRET_PAOPAO:=}"
: "${LINE_TOKEN_PAOPAO:=}"
: "${REPORT_PAGE_URL:=https://www.paopaomao.tw/report}"
: "${REPORT_API_BASE:=}"
: "${DAILY_ACCOUNT_REPORT_SS_ID:=}"
: "${FOLDER_ID_FOR_ATTENDANCE_SHEETS:=}"
: "${GCS_BUCKET_ATTENDANCE:=}"
: "${CUSTOMER_INFO_PAGE_URL:=}"
: "${CUSTOMER_TOKEN_SECRET:=}"
: "${ADS_SS_ID:=}"
: "${GAS_WEBHOOK_URL:=}"
: "${FORWARD_UNKNOWN_TO_GAS:=0}"
: "${WEBHOOK_LOG_VERBOSE:=1}"
# 查空位／SayDou：設定可減少 Sheets API 讀取、避免「Read requests」配額超限（見 set-env.sh 註解）
: "${SAYDOU_BEARER_TOKEN:=}"
# Token 異常／查空位除錯時 LINE Push 通知管理員（需 ADMIN_LINE_USER_ID；使用 LINE_TOKEN_PAOSTAFF 推播）
: "${ADMIN_LINE_USER_ID:=}"
# 選填：若仍要寄信可設 GMAIL_*
: "${ADMIN_EMAIL:=}"
: "${GMAIL_USER:=}"
: "${GMAIL_APP_PASSWORD:=}"
# 店家本月出勤 403 時可設：Secret Manager 密碼名稱（金鑰會掛到 /secrets/sa-key.json，並設 GOOGLE_APPLICATION_CREDENTIALS）
: "${SA_KEY_SECRET_NAME:=}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"
SERVICE_NAME="pao-checkin-api"

echo "=== 1. 建映像（含 server.js /line-webhook）==="
gcloud builds submit --tag "$IMAGE"

echo "=== 2. 部署 Cloud Run Service（node index.js serve）==="
if [ -n "${PAO_CAT_CORE_API_URL:-}" ] && [ -n "${PAO_CAT_SECRET_KEY:-}" ]; then
  echo "Core API 已設定（PAO_CAT_CORE_API_URL 有值），神美日報/上月小費/我要了解客人 將可用"
else
  echo "提醒：PAO_CAT_CORE_API_URL 或 PAO_CAT_SECRET_KEY 未設，神美日報等會回「Core API 未設定」"
fi

# Only override env vars when non-empty, to avoid wiping
# existing Cloud Run config with empty values.
append_env() {
  local k="$1"
  local v="$2"
  if [ -n "${v:-}" ]; then
    if [ -z "${ENV_VARS:-}" ]; then
      ENV_VARS="${k}=${v}"
    else
      ENV_VARS="${ENV_VARS},${k}=${v}"
    fi
  fi
}
# 允許空值，用於必須「清掉舊值」的變數（如 GIVEME_PROXY_URL 改直連時）
append_env_or_clear() {
  local k="$1"
  local v="${2:-}"
  if [ -z "${ENV_VARS:-}" ]; then
    ENV_VARS="${k}=${v}"
  else
    ENV_VARS="${ENV_VARS},${k}=${v}"
  fi
}

# required
ENV_VARS=""
append_env "LINE_STAFF_SS_ID" "$LINE_STAFF_SS_ID"
append_env "LINE_CHANNEL_SECRET" "$LINE_CHANNEL_SECRET"
append_env "LINE_TOKEN_PAOSTAFF" "$LINE_TOKEN_PAOSTAFF"

# optional (only when provided)
append_env "LINE_HQ_SS_ID" "$LINE_HQ_SS_ID"
append_env "LINE_STORE_SS_ID" "$LINE_STORE_SS_ID"
append_env "INTEGRATED_SHEET_SS_ID" "$INTEGRATED_SHEET_SS_ID"
append_env "PAO_CAT_CORE_API_URL" "$PAO_CAT_CORE_API_URL"
append_env "PAO_CAT_SECRET_KEY" "$PAO_CAT_SECRET_KEY"
append_env "LEGACY_GAS_CORE_API_URL" "$LEGACY_GAS_CORE_API_URL"
append_env "LEGACY_GAS_STORES_API_URL" "$LEGACY_GAS_STORES_API_URL"
append_env "ADMIN_KEY" "$ADMIN_KEY"
append_env "PAOPAO_STORE_SS_ID" "$PAOPAO_STORE_SS_ID"
append_env "LINE_CHANNEL_SECRET_PAOPAO" "$LINE_CHANNEL_SECRET_PAOPAO"
append_env "LINE_TOKEN_PAOPAO" "$LINE_TOKEN_PAOPAO"
append_env "EXTERNAL_SS_ID" "$EXTERNAL_SS_ID"
append_env "ACH_SHEET_NAME" "$ACH_SHEET_NAME"
append_env "REPORT_PAGE_URL" "$REPORT_PAGE_URL"
append_env "REPORT_API_BASE" "$REPORT_API_BASE"
append_env "DAILY_ACCOUNT_REPORT_SS_ID" "$DAILY_ACCOUNT_REPORT_SS_ID"
append_env "FOLDER_ID_FOR_ATTENDANCE_SHEETS" "$FOLDER_ID_FOR_ATTENDANCE_SHEETS"
append_env "GCS_BUCKET_ATTENDANCE" "$GCS_BUCKET_ATTENDANCE"
append_env "CUSTOMER_INFO_PAGE_URL" "$CUSTOMER_INFO_PAGE_URL"
append_env "CUSTOMER_TOKEN_SECRET" "$CUSTOMER_TOKEN_SECRET"
append_env "ADS_SS_ID" "$ADS_SS_ID"
append_env "GAS_WEBHOOK_URL" "$GAS_WEBHOOK_URL"
append_env "FORWARD_UNKNOWN_TO_GAS" "$FORWARD_UNKNOWN_TO_GAS"
append_env "WEBHOOK_LOG_VERBOSE" "$WEBHOOK_LOG_VERBOSE"
append_env "SAYDOU_BEARER_TOKEN" "$SAYDOU_BEARER_TOKEN"
append_env "ADMIN_LINE_USER_ID" "$ADMIN_LINE_USER_ID"
append_env "ADMIN_EMAIL" "$ADMIN_EMAIL"
append_env "GMAIL_USER" "$GMAIL_USER"
append_env "GMAIL_APP_PASSWORD" "$GMAIL_APP_PASSWORD"
# 直連 Giveme 時必須傳空值覆蓋舊 VM proxy，否則會出現「IP 不在白名單 136.115.207.151」
append_env_or_clear "GIVEME_PROXY_URL" "${GIVEME_PROXY_URL:-}"
append_env_or_clear "GIVEME_PICTURE_PROXY_URL" "${GIVEME_PICTURE_PROXY_URL:-}"
append_env "GIVEME_UNCODE" "$GIVEME_UNCODE"
append_env "GIVEME_IDNO" "$GIVEME_IDNO"
append_env "GIVEME_PASSWORD" "$GIVEME_PASSWORD"
append_env "ODOO_URL" "$ODOO_URL"
append_env "ODOO_DB" "$ODOO_DB"
append_env "ODOO_USERNAME" "$ODOO_USERNAME"
append_env "ODOO_PASSWORD" "$ODOO_PASSWORD"

if [ -n "${SA_KEY_SECRET_NAME:-}" ]; then
  append_env "GOOGLE_APPLICATION_CREDENTIALS" "/secrets/sa-key.json"
  echo "將掛載 Secret: ${SA_KEY_SECRET_NAME} -> /secrets/sa-key.json（店家本月出勤用）"
fi

# 固定出口 IP（Giveme 白名單）：先執行 scripts/setup-static-egress.sh，再設 EGRESS_NETWORK + EGRESS_SUBNET 後部署
VPC_EGRESS_ARGS=""
if [ -n "${EGRESS_NETWORK:-}" ] && [ -n "${EGRESS_SUBNET:-}" ]; then
  VPC_EGRESS_ARGS="--network=$EGRESS_NETWORK --subnet=$EGRESS_SUBNET --vpc-egress=all-traffic"
  echo "將使用固定出口 IP（VPC egress: $EGRESS_NETWORK / $EGRESS_SUBNET）"
fi

# Cloud Run Service 需執行 node index.js serve（--args 多個值用逗號分隔）
RUN_ARGS="index.js,serve"
if [ -n "${SA_KEY_SECRET_NAME:-}" ]; then
  gcloud run deploy "$SERVICE_NAME" \
    --image "$IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --command "node" \
    --args "$RUN_ARGS" \
    --set-env-vars "$ENV_VARS" \
    --set-secrets "/secrets/sa-key.json=${SA_KEY_SECRET_NAME}:latest" \
    --min-instances 0 \
    --max-instances 10 \
    --cpu-boost \
    $VPC_EGRESS_ARGS
else
  gcloud run deploy "$SERVICE_NAME" \
    --image "$IMAGE" \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --command "node" \
    --args "$RUN_ARGS" \
    --set-env-vars "$ENV_VARS" \
    --min-instances 0 \
    --max-instances 10 \
    --cpu-boost \
    $VPC_EGRESS_ARGS
fi

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')
echo ""
echo "=== 完成 ==="
echo "服務網址: $URL"
echo "員工打卡 LINE Webhook: ${URL}/line-webhook"
echo "各店訊息一覽表 LINE Webhook: ${URL}/store-line-webhook"
