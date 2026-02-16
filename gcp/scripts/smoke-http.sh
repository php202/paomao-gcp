#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-}"
KEY="${2:-}"

if [ -z "$BASE_URL" ] || [ -z "$KEY" ]; then
  echo "Usage: $0 <base-url> <core-key>"
  echo "Example: $0 https://pao-checkin-api-xxxxx.a.run.app xxxxx"
  exit 2
fi

curl -fsS "$BASE_URL/health"
echo ""
curl -fsS "$BASE_URL/core?action=getLineSayDouInfoMap&key=$KEY"
echo ""

echo "OK"

