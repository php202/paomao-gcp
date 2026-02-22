#!/bin/bash
# 照「docs/執行指南_GCP 權限與步驟.md」建立 Job + Scheduler
# 執行前：source set-env.sh，並設定試算表 ID（LINE_STAFF_SS_ID、LINE_STORE_SS_ID、OUTPUT_SS_ID、TOKEN_SHEET_SS_ID）
# 也會建立 run acc（日報）的每日凌晨排程（pao-daily-report）
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
PAO_CAT_CORE_API_URL="${PAO_CAT_CORE_API_URL:-}"
PAO_CAT_SECRET_KEY="${PAO_CAT_SECRET_KEY:-}"
DAILY_REPORT_CRON="${DAILY_REPORT_CRON:-10 0 * * *}" # 台灣時間凌晨 00:10

if [ -z "$PAO_CAT_CORE_API_URL" ] || [ -z "$PAO_CAT_SECRET_KEY" ]; then
  echo "錯誤：daily-report 需要 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY（請在 set-env.sh 設定）"
  exit 1
fi

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

# Job 3：run acc（日報，GCP 版）
gcloud run jobs create pao-daily-report \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 60m \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID,DAILY_ACCOUNT_REPORT_SS_ID=$OUTPUT_SS_ID,PAO_CAT_CORE_API_URL=$PAO_CAT_CORE_API_URL,PAO_CAT_SECRET_KEY=$PAO_CAT_SECRET_KEY,FETCH_BATCH_SIZE=${FETCH_BATCH_SIZE:-10}" \
  --set-secrets "GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-daily-report --image "$IMAGE" --region "$REGION" \
  --set-env-vars "ADMIN_EMAIL=paopaomao.of@gmail.com,TOKEN_SHEET_SS_ID=$TOKEN_SHEET_SS_ID,DAILY_ACCOUNT_REPORT_SS_ID=$OUTPUT_SS_ID,PAO_CAT_CORE_API_URL=$PAO_CAT_CORE_API_URL,PAO_CAT_SECRET_KEY=$PAO_CAT_SECRET_KEY,FETCH_BATCH_SIZE=${FETCH_BATCH_SIZE:-10}" \
  --set-secrets "GMAIL_USER=gmail-user:latest,GMAIL_APP_PASSWORD=gmail-app-password:latest" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")

gcloud run jobs update pao-daily-report --region "$REGION" \
  --command "node" --args "index.js,daily-report"

# Job 4：各店訊息一覽表 - Pending 巡航（每 1 分鐘）
gcloud run jobs create pao-stores-check-timeout-pending \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 5m \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID,PENDING_TIMEOUT_MINUTES=${PENDING_TIMEOUT_MINUTES:-3}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-stores-check-timeout-pending --image "$IMAGE" --region "$REGION" \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID,PENDING_TIMEOUT_MINUTES=${PENDING_TIMEOUT_MINUTES:-3}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")
gcloud run jobs update pao-stores-check-timeout-pending --region "$REGION" \
  --command "node" --args "index.js,check-timeout-pending"

# Job 5：各店訊息一覽表 - 準客挽留清單清理（每日 03:00）
gcloud run jobs create pao-stores-cleanup-retention \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 10m \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID,PENDING_STALE_DAYS=${PENDING_STALE_DAYS:-7}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-stores-cleanup-retention --image "$IMAGE" --region "$REGION" \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID,PENDING_STALE_DAYS=${PENDING_STALE_DAYS:-7}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")
gcloud run jobs update pao-stores-cleanup-retention --region "$REGION" \
  --command "node" --args "index.js,cleanup-retention-list"

# Job 6：各店訊息一覽表 - 候補清單自動 Push（每日 22:00）
gcloud run jobs create pao-stores-waitlist-auto-push \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 10m \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-stores-waitlist-auto-push --image "$IMAGE" --region "$REGION" \
  --set-env-vars "INTEGRATED_SHEET_SS_ID=$LINE_STORE_SS_ID" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")
gcloud run jobs update pao-stores-waitlist-auto-push --region "$REGION" \
  --command "node" --args "index.js,waitlist-auto-push"

# Job 7：各店訊息一覽表 - 產出明日預約客人客戶狀態（每日 22:00；不 Push）
gcloud run jobs create pao-stores-refresh-customers-tomorrow \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 60m \
  --set-env-vars "LINE_STORE_SS_ID=$LINE_STORE_SS_ID,CUSTOMER_SHEET_ID=${CUSTOMER_SHEET_ID:-1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M},CUSTOMER_HISTORY_SHEET_NAMES=${CUSTOMER_HISTORY_SHEET_NAMES:-sheet1,2025前},EMPLOYEE_NOTES_SHEET_NAME=${EMPLOYEE_NOTES_SHEET_NAME:-表單回覆 3},REFRESH_CUSTOMER_CONCURRENCY=${REFRESH_CUSTOMER_CONCURRENCY:-3}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT") \
  2>/dev/null || gcloud run jobs update pao-stores-refresh-customers-tomorrow --image "$IMAGE" --region "$REGION" \
  --set-env-vars "LINE_STORE_SS_ID=$LINE_STORE_SS_ID,CUSTOMER_SHEET_ID=${CUSTOMER_SHEET_ID:-1wAfl4Dipag6Eh8msOYUc0ZUepaeQR_HnQNEcxIVUt3M},CUSTOMER_HISTORY_SHEET_NAMES=${CUSTOMER_HISTORY_SHEET_NAMES:-sheet1,2025前},EMPLOYEE_NOTES_SHEET_NAME=${EMPLOYEE_NOTES_SHEET_NAME:-表單回覆 3},REFRESH_CUSTOMER_CONCURRENCY=${REFRESH_CUSTOMER_CONCURRENCY:-3}" \
  $([ -n "$SERVICE_ACCOUNT" ] && echo "--service-account=$SERVICE_ACCOUNT")
gcloud run jobs update pao-stores-refresh-customers-tomorrow --region "$REGION" \
  --command "node" --args "index.js,refresh-customers-by-tomorrow-reservations"

echo "=== 5. 給 Scheduler 觸發 Job 的權限 ==="
gcloud run jobs add-iam-policy-binding pao-check-token --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-employee-report --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-daily-report --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-stores-check-timeout-pending --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-stores-cleanup-retention --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-stores-waitlist-auto-push --region="$REGION" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"
gcloud run jobs add-iam-policy-binding pao-stores-refresh-customers-tomorrow --region="$REGION" \
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

# 每天凌晨（台灣時區）跑 run acc（日報）
gcloud scheduler jobs create http pao-daily-report-midnight \
  --location "$REGION" \
  --schedule "$DAILY_REPORT_CRON" \
  --time-zone "Asia/Taipei" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-daily-report:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || gcloud scheduler jobs update http pao-daily-report-midnight \
  --location "$REGION" \
  --schedule "$DAILY_REPORT_CRON" \
  --time-zone "Asia/Taipei" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-daily-report:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}"

# 每 1 分鐘：Pending 巡航
gcloud scheduler jobs create http pao-stores-check-timeout-pending-1m \
  --location "$REGION" \
  --schedule "* * * * *" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-stores-check-timeout-pending:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-stores-check-timeout-pending-1m 可能已存在，可略過或到 Console 編輯）"

# 每日 03:00（台灣）：準客挽留清單清理
gcloud scheduler jobs create http pao-stores-cleanup-retention-daily \
  --location "$REGION" \
  --schedule "0 3 * * *" \
  --time-zone "Asia/Taipei" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-stores-cleanup-retention:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-stores-cleanup-retention-daily 可能已存在，可略過或到 Console 編輯）"

# 每日 22:00（台灣）：候補清單自動 Push
gcloud scheduler jobs create http pao-stores-waitlist-auto-push-daily \
  --location "$REGION" \
  --schedule "0 22 * * *" \
  --time-zone "Asia/Taipei" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-stores-waitlist-auto-push:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-stores-waitlist-auto-push-daily 可能已存在，可略過或到 Console 編輯）"

# 每日 22:00（台灣）：明日預約客人 - 產出客人消費狀態（不 Push）
gcloud scheduler jobs create http pao-stores-refresh-customers-tomorrow-daily \
  --location "$REGION" \
  --schedule "0 22 * * *" \
  --time-zone "Asia/Taipei" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/pao-stores-refresh-customers-tomorrow:run" \
  --http-method POST \
  --oauth-service-account-email "${SA}" \
  2>/dev/null || echo "（pao-stores-refresh-customers-tomorrow-daily 可能已存在，可略過或到 Console 編輯）"

echo "完成。請到 Console 手動執行一次 Job 測試："
echo "  https://console.cloud.google.com/run?project=$PROJECT_ID"
echo "新增：pao-daily-report（run acc）已排程於 Asia/Taipei $DAILY_REPORT_CRON"
echo "試算表 ID 或 Core 參數若需調整，請編輯 set-env.sh 後重新執行本腳本（或手動 update job）。"