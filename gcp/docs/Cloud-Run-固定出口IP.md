# Cloud Run 固定出口 IP（給 Giveme 白名單用）

Cloud Run **預設沒有固定對外 IP**，出口 IP 會隨 instance 變動。若第三方（例如 Giveme 電子發票）要求 **IP 白名單**，需讓 Cloud Run 的對外流量改走 **VPC + Cloud NAT**，由你預留的 **靜態 IP** 出去。

## 要在哪裡改？

全部在 **Google Cloud Console**（或 gcloud）完成，**不用改程式碼**：

1. **VPC 網路**：要有 VPC 與子網路（可用 default，或自建）。
2. **預留靜態 IP**：在 **VPC network → IP addresses** 新增一筆「Regional」靜態 IP，**這個 IP 就是你要填進 Giveme 白名單的位址**（例如你目前的 `136.115.207.151`）。
3. **Cloud Router + Cloud NAT**：在 **Network services → Cloud NAT** 建立 NAT，並指定使用上一步的靜態 IP；NAT 會讓從該 VPC 出去的流量都從這個 IP 出去。
4. **Cloud Run 走 VPC**：部署 Cloud Run 時設定「**所有對外流量經由 VPC**」，並透過 **Direct VPC egress** 或 **Serverless VPC Access connector** 連到上述 VPC。

改「固定 IP」= 改第 2 步的靜態 IP（或改 NAT 使用的 IP），然後在 Giveme 後台更新白名單。

---

## 方式一：GCP Console 操作（建議先看一遍）

### 1. 預留靜態 IP（這就是你的固定出口 IP）

- 左側選單：**VPC network → IP addresses**（或搜尋 "IP addresses"）。
- **Reserve external static address**：
  - Name：例如 `pao-run-egress-ip`
  - Region：選與 Cloud Run 相同，例如 **asia-east1**。
  - 建立後畫面上會顯示 **Address**，例如 `136.115.207.151` → 把這個填進 Giveme 白名單。

### 2. Cloud Router

- **Network services → Cloud Routers**。
- **Create router**：
  - Name：例如 `pao-run-router`
  - Network：default 或你的 VPC
  - Region：**asia-east1**（與 Cloud Run、靜態 IP 同區）。

### 3. Cloud NAT

- **Network services → Cloud NAT**。
- **Create NAT gateway**：
  - Name：例如 `pao-run-nat`
  - Region / VPC / Router：選剛建立的 Router。
  - **NAT type**：選 **Manual**，在 **External IP addresses** 選剛預留的靜態 IP（例如 `pao-run-egress-ip`）。
  - Subnet：選要涵蓋的 subnet（例如 default 在 asia-east1 的 subnet）。

### 4. 讓 Cloud Run 走 VPC（二選一）

**選項 A：Direct VPC egress（較新、建議）**

- **Cloud Run → 選你的服務（例如 pao-checkin-api）→ 編輯與部署新修訂版本**。
- **Connections**（連線／網路）區塊：
  - 啟用 **Direct VPC egress**（或「連線至 VPC」）。
  - 選 **Network** 與 **Subnet**（須與 Cloud NAT 的 subnet 一致）。
  - **Egress** 選 **Route all traffic through the VPC**（所有流量經由 VPC）。
- 部署後，該服務的對外連線（含打 Giveme）會從上述靜態 IP 出去。

**選項 B：Serverless VPC Access connector**

- 先建 **Serverless VPC Access connector**（與 Cloud Run 同 region，例如 asia-east1）。
- 在 Cloud Run 部署時：
  - **Connections** 選 **VPC connector**，選剛建的 connector。
  - **Traffic** 選 **Route all traffic through the VPC connector**。
- 再確保該 connector 所在 subnet 有被 Cloud NAT 涵蓋（同上 Router/NAT 設定）。

---

## 方式二：gcloud 指令範例（asia-east1）

```bash
# 變數（請改成你的）
REGION=asia-east1
PROJECT_ID=gen-lang-client-0828139766
SERVICE_NAME=pao-checkin-api
NETWORK=default
SUBNET=default  # 或你的 subnet 名稱

# 1. 預留靜態 IP（此 IP 即填進 Giveme 白名單）
gcloud compute addresses create pao-run-egress-ip --region=$REGION --project=$PROJECT_ID

# 2. 查剛建立的 IP（記下來填 Giveme）
gcloud compute addresses describe pao-run-egress-ip --region=$REGION --format='get(address)'

# 3. 建立 Cloud Router
gcloud compute routers create pao-run-router \
  --network=$NETWORK --region=$REGION --project=$PROJECT_ID

# 4. 建立 Cloud NAT（使用上面那個靜態 IP）
gcloud compute routers nats create pao-run-nat \
  --router=pao-run-router \
  --region=$REGION \
  --nat-custom-subnet-ip-ranges=$SUBNET \
  --nat-external-ip-pool=pao-run-egress-ip \
  --project=$PROJECT_ID

# 5. 部署 Cloud Run 並改走 VPC（Direct VPC egress）
# 若你平常是用 deploy-line-webhook.sh，需在 gcloud run deploy 時加上 --network、--subnet、--vpc-egress=all-traffic
# 或到 Console 該服務「編輯」→ Connections 裡設定 Direct VPC egress + Route all traffic
```

若目前是用 **deploy-line-webhook.sh** 部署，腳本裡沒有 `--network`/`--subnet`，**固定 IP 需在 Console 手動設**：  
Cloud Run → 選服務 → **Edit & deploy new revision** → **Connections** 裡設定 VPC egress，再部署。之後若要**換成另一個固定 IP**，只要在 **IP addresses** 再預留一筆，並在 **Cloud NAT** 改成用新 IP，然後在 Giveme 後台改白名單即可。

---

## 總結：哪裡改固定 IP？

| 要做的事 | 在哪裡改 |
|----------|----------|
| **查／設定「這個固定 IP 是多少」** | GCP Console → **VPC network → IP addresses**：預留的 Regional 靜態 IP 的 **Address** 欄位即為出口 IP，填進 Giveme 白名單。 |
| **換成另一個固定 IP** | 再預留一筆靜態 IP → **Cloud NAT** 改為使用新 IP → Giveme 後台白名單改為新 IP。 |
| **讓 Cloud Run 使用這組固定 IP** | **Cloud Run** → 該服務 → **Edit & deploy new revision** → **Connections** 設定 **Direct VPC egress**（或 VPC connector）且 **Route all traffic through the VPC**。 |

官方文件：[Static outbound IP address \| Cloud Run](https://cloud.google.com/run/docs/configuring/static-outbound-ip)
