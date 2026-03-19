# 泡泡貓科技美容 — API 隔離與獨立部署方案

> 適合 1 人團隊 + AI 助手的務實架構，不過度工程
> 建立日期：2026-03-19

---

## 整體架構概覽

```
Internet
    │
    ▼
Cloudflare Tunnel
    │
    ▼
nginx (port 8080, 本機反向代理)
    │
    ├──▶ port 3000  main-server.js     (現有核心：門市、會計、員工、薪資...)
    ├──▶ port 3100  inspection-api.js  (巡店評分)
    ├──▶ port 3200  exam-api.js        (技術考核)
    └──▶ port 3300  contract-api.js    (合約管理 + 續約 Agent)

共用層：
    ├── PostgreSQL :5432 (paomao)
    ├── shared/middleware/  (auth, role check)
    └── shared/db/          (pg pool 設定)
```

---

## 一、URL 路由設計

### 1-1 Port 分配規範

| Service | Port | 說明 |
|---------|------|------|
| main-server | 3000 | 現有所有功能（保持不動） |
| inspection-api | 3100 | 巡店評分 |
| exam-api | 3200 | 技術考核 |
| contract-api | 3300 | 合約管理 / 續約 Agent |
| *預留* | 3400–3499 | 未來擴充 |

### 1-2 URL 路由對照

```
# 現有（不動）
/api/accounting/*   → :3000
/api/stores/*       → :3000
/api/cleaning/*     → :3000
/api/employees/*    → :3000
/api/payroll/*      → :3000
/api/refunds/*      → :3000
/api/booking/*      → :3000

# 新增（獨立服務）
/api/inspection/*   → :3100  巡店評分
/api/exam/*         → :3200  技術考核
/api/contracts/*    → :3300  合約管理
/api/renewal/*      → :3300  續約品質控管（同合約服務）
```

### 1-3 nginx 設定範例

```nginx
# /opt/homebrew/etc/nginx/servers/paomao-api.conf

upstream main_server    { server 127.0.0.1:3000; }
upstream inspection_api { server 127.0.0.1:3100; }
upstream exam_api       { server 127.0.0.1:3200; }
upstream contract_api   { server 127.0.0.1:3300; }

server {
    listen 8080;
    server_name _;

    # ── 新模組（先路由，避免被主服務攔截）──
    location /api/inspection/ {
        proxy_pass         http://inspection_api;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
        proxy_next_upstream error timeout http_502 http_503;
        error_page 502 503 504 = @inspection_fallback;
    }
    location @inspection_fallback {
        default_type application/json;
        return 503 '{"error":"inspection_service_unavailable","message":"巡店評分服務暫時無法使用，請稍後再試"}';
    }

    location /api/exam/ {
        proxy_pass         http://exam_api;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
        proxy_next_upstream error timeout http_502 http_503;
        error_page 502 503 504 = @exam_fallback;
    }
    location @exam_fallback {
        default_type application/json;
        return 503 '{"error":"exam_service_unavailable","message":"技術考核服務暫時無法使用，請稍後再試"}';
    }

    location /api/contracts/ {
        proxy_pass         http://contract_api;
        proxy_read_timeout 60s;
        proxy_connect_timeout 5s;
        proxy_next_upstream error timeout http_502 http_503;
        error_page 502 503 504 = @contract_fallback;
    }
    location /api/renewal/ {
        proxy_pass         http://contract_api;
        proxy_read_timeout 60s;
        proxy_connect_timeout 5s;
        error_page 502 503 504 = @contract_fallback;
    }
    location @contract_fallback {
        default_type application/json;
        return 503 '{"error":"contract_service_unavailable","message":"合約管理服務暫時無法使用，請稍後再試"}';
    }

    # ── 其餘全部給主服務 ──
    location / {
        proxy_pass         http://main_server;
        proxy_read_timeout 30s;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

### 1-4 共用 Middleware 策略

**做法：本地 shared 套件（不用發布 npm）**

```
/Users/paopaomao/paomao-server/
├── shared/
│   ├── middleware/
│   │   ├── auth.js          # Session/JWT 驗證（從 main-server 提取）
│   │   ├── roleCheck.js     # 角色權限
│   │   └── requestLogger.js # 請求 log
│   ├── db/
│   │   └── pool.js          # pg Pool singleton
│   └── utils/
│       ├── apiResponse.js   # 統一回應格式
│       └── circuitBreaker.js
├── main-server/
│   └── server.js            # 原本的 13000+ 行
├── inspection-api/
│   └── index.js
├── exam-api/
│   └── index.js
└── contract-api/
    └── index.js
```

各服務直接 require：
```js
// inspection-api/index.js
const { authenticate } = require('../shared/middleware/auth')
const { requireRole }  = require('../shared/middleware/roleCheck')
const pool             = require('../shared/db/pool')
```

> **為何不用 npm workspaces？** 1 人團隊 + 同一台機器，直接 relative require 最簡單。

---

## 二、錯誤隔離機制 (Circuit Breaker)

### 2-1 後端層：nginx 是第一道防線

nginx 的 `proxy_next_upstream` + `proxy_connect_timeout`：
- 新服務連不上 → nginx 回 503 JSON，不影響主服務
- 新服務慢 → timeout 保護，不 block 其他請求

### 2-2 前端層：Graceful Degradation

```js
// 前端 API 呼叫範例
async function fetchModuleData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, offline: true, message: '模組暫時無法使用' };
  }
}
```

UI 顯示「模組維護中」badge，不崩頁面。

### 2-3 輕量 Circuit Breaker（Phase 2）

```js
// shared/utils/circuitBreaker.js
class SimpleCircuitBreaker {
  constructor(name, { failThreshold = 3, cooldownMs = 30000 } = {}) {
    this.name = name;
    this.failures = 0;
    this.failThreshold = failThreshold;
    this.cooldownMs = cooldownMs;
    this.openUntil = null;
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.openUntil) {
        throw new Error(`Circuit OPEN: ${this.name}`);
      }
      this.state = 'HALF_OPEN';
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() { this.failures = 0; this.state = 'CLOSED'; }
  onFailure() {
    this.failures++;
    if (this.failures >= this.failThreshold) {
      this.state = 'OPEN';
      this.openUntil = Date.now() + this.cooldownMs;
      console.warn(`[CircuitBreaker] ${this.name} OPEN for ${this.cooldownMs}ms`);
    }
  }
}
module.exports = SimpleCircuitBreaker;
```

---

## 三、部署策略

### 3-1 技術選擇

| 方案 | 適合度 | 理由 |
|------|--------|------|
| **多 process + launchd** ✅ | ⭐⭐⭐⭐⭐ | 現有基礎，最低學習成本 |
| Docker Compose | ⭐⭐⭐ | 隔離好，但 Mac mini 加 overhead |
| PM2 cluster | ⭐⭐⭐⭐ | 推薦 Phase 2 升級 |
| Serverless | ⭐ | 不適合，延遲高，PG 連線複雜 |
| k8s | ❌ | 嚴重過度工程 |

**結論：Phase 1 用 launchd，Phase 2 考慮 PM2**

### 3-2 launchd plist 範例

```xml
<!-- ~/Library/LaunchAgents/com.paomao.inspection-api.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.paomao.inspection-api</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/paopaomao/paomao-server/inspection-api/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/paopaomao/paomao-server/inspection-api</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>    <string>production</string>
        <key>PORT</key>        <string>3100</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/paopaomao/logs/inspection-api.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/paopaomao/logs/inspection-api.error.log</string>
    <key>RunAtLoad</key>       <true/>
    <key>KeepAlive</key>       <true/>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
```

### 3-3 零停機更新腳本

```bash
#!/bin/bash
# scripts/deploy-service.sh
# 用法: ./deploy-service.sh inspection-api

SERVICE=$1
PLIST_PATH="$HOME/Library/LaunchAgents/com.paomao.${SERVICE}.plist"
SERVICE_DIR="$HOME/paomao-server/${SERVICE}"

echo "🚀 部署 ${SERVICE}..."

cd "$SERVICE_DIR"
git pull origin main
npm ci --production

# 語法檢查
node --check index.js || { echo "❌ 語法錯誤"; exit 1; }

# 重啟（其他服務不受影響）
launchctl kickstart -k gui/$(id -u)/com.paomao.${SERVICE}
sleep 2

# 健康檢查
PORT=$(grep -A1 '>PORT<' "$PLIST_PATH" | grep -o '[0-9]*')
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health")

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ ${SERVICE} 部署成功 (port ${PORT})"
else
    echo "❌ 健康檢查失敗 (HTTP ${HTTP_CODE})"
    exit 1
fi
```

每個服務加 `/health` endpoint：
```js
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'inspection-api', ts: Date.now() });
});
```

### 3-4 Cloudflare Tunnel

Tunnel 只需指向 nginx，不用改：
```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: dashboard.paopaomao.tw
    service: http://localhost:8080   # nginx
  - service: http_status:404
```

---

## 四、目錄結構

```
/Users/paopaomao/paomao-server/
├── shared/                     # 共用模組
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── roleCheck.js
│   │   └── requestLogger.js
│   ├── db/
│   │   └── pool.js
│   └── utils/
│       ├── apiResponse.js
│       └── circuitBreaker.js
├── main-server/                # 現有 server.js
│   ├── server.js
│   ├── lib/
│   └── views/
├── inspection-api/             # 巡店評分
│   ├── index.js
│   ├── routes/
│   └── package.json
├── exam-api/                   # 技術考核
│   ├── index.js
│   ├── routes/
│   └── package.json
├── contract-api/               # 合約管理 + 續約 Agent
│   ├── index.js
│   ├── routes/
│   ├── agents/
│   │   └── renewalQualityAgent.js
│   └── package.json
├── scripts/
│   ├── deploy-service.sh
│   └── health-check-all.sh
└── nginx/
    └── paomao-api.conf
```

---

## 五、分階段實施計劃

### Phase 1 — 最小可行（1-2 週）

> 目標：新模組獨立跑，舊系統零改動

- [ ] 建立目錄結構 `paomao-server/`
- [ ] 從 server.js 提取 `shared/middleware/auth.js` 和 `shared/db/pool.js`
- [ ] 設定 nginx 反向代理（brew install nginx 或用現有的）
- [ ] 撰寫 `inspection-api/index.js`（最簡單的 CRUD）
- [ ] 建立 launchd plist
- [ ] 更新 Cloudflare Tunnel → nginx（原 :3000 改 :8080）
- [ ] 驗證 `/api/inspection/*` 通，`/api/accounting/*` 照常

**風險：低。主服務完全不動，只加 nginx 前面。**

### Phase 2 — 進階（1 個月）

> 目標：完整錯誤隔離 + 部署自動化

- [ ] 完成 exam-api 和 contract-api
- [ ] 前端加 graceful degradation（OfflineBadge）
- [ ] 建立 deploy-service.sh 腳本
- [ ] 建立 health-check-all.sh（cron 每分鐘跑，失敗發 TG 通知）
- [ ] 考慮升級 PM2（比 launchd 更方便管理多 process）

### Phase 3 — 完整（2 個月）

> 目標：漸進抽出現有模組

- [ ] 從主服務抽出 cleaning → independent service
- [ ] 從主服務抽出 accounting → independent service
- [ ] 建立服務監控 Dashboard（各服務 health/uptime/error rate）
- [ ] 日誌集中管理（可用 loki 或簡單的 log rotation）

---

## 六、資源評估

| 項目 | 預估 |
|------|------|
| 每個 Node.js process | ~50-100MB RAM |
| 4 個服務 + nginx | ~500MB |
| Mac mini M2 16GB | 綽綽有餘 |
| nginx CPU | 可忽略 |
| 開發時間 Phase 1 | 1-2 週 |

---

## 相關文件

- 巡店考核系統：`~/paomao-gcp/gcp/docs/巡店考核系統實施計劃.md`
- 續約品質控管 Agent：`~/paomao-gcp/gcp/docs/續約品質控管Agent規劃.md`
- 模組化 changelog：`~/paomao-gcp/gcp/docs/modularization-changelog.md`
