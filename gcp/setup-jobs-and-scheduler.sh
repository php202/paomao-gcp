#!/bin/bash
# 照「執行指南_GCP 權限與步驟.md」建立 Job + Scheduler
# 執行前：source set-env.sh，並設定試算表 ID（LINE_STAFF_SS_ID、LINE_STORE_SS_ID、OUTPUT_SS_ID、TOKEN_SHEET_SS_ID）
set -e
cd "$(dirname "$0")"
[ -f set-env.sh ] && source set-env.sh

if [ -z "$PROJECT_ID" ] || [ -z "$REGION" ]; then
  echo "錯誤：請先 source set-env.sh（需有 PROJECT_ID、REGION）"
  exit 1
fi

# 試算表 ID 請改成你的實際值（可寫在 set-env.sh）
LINE_STAFF_SS_ID="${LINE_STAFF_SS_ID:-1GH2Xbih}"
LINE_STORE_SS_ID="${LINE_STORE_SS_ID:-1ZV_0vjt}"
OUTPUT_SS_ID="${OUTPUT_SS_ID:-1ZMutegY}"
TOKEN_SHEET_SS_ID="${TOKEN_SHEET_SS_ID:-1-t4KPVK}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# 可選：若你要用自訂服務帳戶 paomao-967 跑 Job，設 USE_SA=1 並在 set-env.sh 設 SERVICE_ACCOUNT=paomao-967@...
if [ -n "$SERVICE_ACCOUNT" ]; then
  SA="$SERVICE_ACCOUNT"
  echo "使用服務帳戶: $SA"
fi

echo "=== 4. 建立兩個 Cloud Run Job ==="
# Job 1：Token 檢查（每次從試算表「預約表單」C2 讀 Token，不依賴 Secret）
gcloud run jobs create pao-check-token \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 5m \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID" \
  --set-secrets "GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-check-token --image "$IMAGE" --region "$REGION" \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID" \
  --set-secrets "GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")

# Job 2：員工業績月報（用試算表 ID）
gcloud run jobs create pao-employee-report \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 60m \
  --set-env-vars "LINE_STAFF_SS_ID=$LINE_STAFF_SS_ID,LINE_STORE_SS_ID=$LINE_STORE_SS_ID,OUTPUT_SS_ID=$OUTPUT_SS_ID,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID,FETCH_BATCH_SIZE=${FETCH_BATCH_SIZE:-10}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-employee-report --image "$IMAGE" --region "$REGION" \
  --set-env-vars "LINE_STAFF_SS_ID=$LINE_STAFF_SS_ID,LINE_STORE_SS_ID=$LINE_STORE_SS_ID,OUTPUT_SS_ID=$OUTPUT_SS_ID,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID,FETCH_BATCH_SIZE=${FETCH_BATCH_SIZE:-10}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")

gcloud run jobs update pao-employee-report --region "$REGION" \
  --command "node" --args "index.js,employee-monthly-report"

echo "=== 5. 給 Scheduler 觸發 Job 的權限 ==="
gcloud run jobs add-iam-policy-binding pao-check-token --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-employee-report --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"

echo "=== 6. 建立 Cloud Scheduler 排程 ==="
# 每日 9:00 台灣 = 1:00 UTC
gcloud scheduler jobs create http pao-check-token-daily \
  --location "$REGION" \
  --schedule "0 1 * * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-check-token:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-check-token-daily 可能已存在，可略過或到 Console 編輯）"

# 每月 1 號 10:00 台灣 = 2:00 UTC
gcloud scheduler jobs create http pao-report-monthly \
  --location "$REGION" \
  --schedule "0 2 1 * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-employee-report:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-report-monthly 可能已存在，可略過或到 Console 編輯）"

echo "完成。請到 Console 手動執行一次 Job 測試："
echo "  https://console.cloud.google.com/run?project=$PROJECT_ID"
echo "試算表 ID 若尚未改成你的，請編輯 set-env.sh 後重新執行本腳本（或手動 update job）。"