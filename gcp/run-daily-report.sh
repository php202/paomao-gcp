#!/bin/bash
cd /Users/paopaomao/paomao-gcp/gcp
source /Users/paopaomao/.openclaw/secrets/gcp-env.sh 2>/dev/null
export $(grep -v '^#' /Users/paopaomao/paomao-gcp/gcp/.env 2>/dev/null | xargs)
exec /opt/homebrew/bin/node index.js daily-report "$@"
