#!/usr/bin/env bash
# 一鍵設定出勤 Excel 用 GCS bucket 的 90 天生命週期（attendance/ 底下超過 90 天的物件自動刪除）
# 使用前：source ../set-env.sh（或 export GCS_BUCKET_ATTENDANCE=你的bucket名稱）
# 執行：./set-gcs-attendance-lifecycle.sh
# 可選：./set-gcs-attendance-lifecycle.sh 其他bucket名稱

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$GCP_DIR/set-env.sh" ] && source "$GCP_DIR/set-env.sh"

BUCKET="${1:-$GCS_BUCKET_ATTENDANCE}"
if [ -z "$BUCKET" ]; then
  echo "請設定 GCS_BUCKET_ATTENDANCE（在 set-env.sh）或傳入 bucket 名稱：" >&2
  echo "  ./set-gcs-attendance-lifecycle.sh pao-attendance-excel" >&2
  exit 1
fi

LIFECYCLE_JSON=$(mktemp)
trap 'rm -f "$LIFECYCLE_JSON"' EXIT
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":90,"matchesPrefix":["attendance/"]}}]}' > "$LIFECYCLE_JSON"

echo "設定 gs://${BUCKET} 生命週期：attendance/ 底下超過 90 天的物件將自動刪除"
gsutil lifecycle set "$LIFECYCLE_JSON" "gs://${BUCKET}"
echo "完成。可執行 gsutil lifecycle get gs://${BUCKET} 檢查。"
