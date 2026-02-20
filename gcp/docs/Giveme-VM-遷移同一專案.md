# Giveme 中繼 VM 遷移到同一專案

目標：把 136.115.207.151 上的 Giveme 中繼程式（`/home/washfacecatgm/invoice-proxy`，`app.js`，port 8080）搬到目前 Cloud Run 所在的 GCP 專案，並取得程式備份。

---

## 一、在現有 VM（136.115.207.151）備份程式與資訊

SSH 登入該 VM 後執行以下指令，取得程式與啟動方式。

### 1. 備份 /home/washfacecatgm/invoice-proxy 並列出啟動方式

```bash
# 以 paopaomao_of 登入後（程式實際在 washfacecatgm 帳號下）
sudo tar -czvf /tmp/invoice-proxy-backup-$(date +%Y%m%d).tar.gz -C /home washfacecatgm/invoice-proxy
sudo chown paopaomao_of:paopaomao_of /tmp/invoice-proxy-backup-*.tar.gz
ls -la /tmp/invoice-proxy-backup-*.tar.gz
```

### 2. 記錄 Node 如何被啟動（必看）

```bash
# 看 8080 是誰在跑（實際為 washfacecatgm 帳號，node /home/washfacecatgm/invoice-proxy/app.js）
ps aux | grep -E 'node|invoice'
# 若有 systemd
systemctl list-units --type=service | grep -iE 'invoice|wash|node'
ls -la /etc/systemd/system/*invoice* /etc/systemd/system/*wash* 2>/dev/null
# 工作目錄與指令
sudo ls -la /proc/$(pgrep -f "invoice-proxy/app.js" | head -1)/cwd 2>/dev/null
tr '\0' ' ' < /proc/$(pgrep -f "invoice-proxy/app.js" | head -1)/cmdline; echo
ls -la /home/washfacecatgm/invoice-proxy
cat /home/washfacecatgm/invoice-proxy/package.json 2>/dev/null | head -25
```

### 3. 下載備份到本機

在你**本機**（有 SSH 到該 VM 的環境）執行：

```bash
cd /path/to/node_express/gcp
mkdir -p vm-backup
scp paopaomao_of@136.115.207.151:/tmp/invoice-proxy-backup-*.tar.gz vm-backup/
```

若 136.115.207.151 是從 GCP Console 用「在瀏覽器視窗中開啟」SSH，可改用「上傳檔案」把 `/tmp/invoice-proxy-backup-*.tar.gz` 下載到本機，或在本機用 `gcloud compute scp`（見下方）。

### 4. 用 gcloud 下載（若 VM 在另一專案）

若該 VM 在專案 A，先設好專案與區域後：

```bash
gcloud compute scp --zone=ZONE INSTANCE_NAME:/tmp/invoice-proxy-backup-YYYYMMDD.tar.gz ./vm-backup/ --project=PROJECT_A
```

ZONE、INSTANCE_NAME、PROJECT_A 換成該 VM 的實際值（instance-20260127-080410 可能在 asia-east1-b 等）。

---

## 二、在目標專案建立新 VM 並部署

目標專案 = 跑 pao-checkin-api（Cloud Run）的專案。

### 1. 建立 VM 與保留靜態 IP

```bash
export PROJECT_ID=gen-lang-client-0828139766   # 你的專案
export REGION=asia-east1
export ZONE=asia-east1-b
export VM_NAME=giveme-proxy
export STATIC_IP_NAME=giveme-proxy-ip

# 保留靜態 IP
gcloud compute addresses create $STATIC_IP_NAME --region=$REGION --project=$PROJECT_ID

# 查 IP（待會要填進 Giveme 白名單與 set-env.sh）
gcloud compute addresses describe $STATIC_IP_NAME --region=$REGION --project=$PROJECT_ID --format="get(address)"

# 建立 VM（e2-micro 或 e2-small）
gcloud compute instances create $VM_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --machine-type=e2-micro \
  --network-interface=address=$STATIC_IP_NAME,network-tier=PREMIUM \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=10GB \
  --tags=giveme-proxy,http-server
```

### 2. 開放防火牆 8080

```bash
gcloud compute firewall-rules create allow-giveme-proxy-8080 \
  --project=$PROJECT_ID \
  --allow=tcp:8080 \
  --target-tags=giveme-proxy \
  --source-ranges=0.0.0.0/0
```

### 3. SSH 進新 VM 並安裝 Node、還原程式

```bash
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT_ID
```

在新 VM 上：

```bash
# 安裝 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 建立目錄
sudo mkdir -p /home/wash
sudo chown $USER:$USER /home/wash
```

在本機上傳備份並解壓（或從本機 SCP 到新 VM）：

```bash
# 本機執行（新 VM 的 EXTERNAL_IP 或 VM_NAME）
gcloud compute scp vm-backup/invoice-proxy-backup-YYYYMMDD.tar.gz $VM_NAME:/tmp/ --zone=$ZONE --project=$PROJECT_ID
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT_ID --command="mkdir -p /home/washfacecatgm && cd /home/washfacecatgm && tar -xzvf /tmp/invoice-proxy-backup-YYYYMMDD.tar.gz && ls -la invoice-proxy"
```

在新 VM 上：

```bash
cd /home/washfacecatgm/invoice-proxy
npm install --production   # 若有 package.json
# 舊 VM 啟動方式：node /home/washfacecatgm/invoice-proxy/app.js
node app.js
# 在另一終端 curl http://localhost:8080/invoice 測試
```

### 4. 設成開機自動啟動（systemd）

在新 VM 上建立（路徑與入口與舊 VM 一致）：

```bash
sudo tee /etc/systemd/system/giveme-proxy.service << 'EOF'
[Unit]
Description=Giveme Invoice Proxy (invoice-proxy)
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/invoice-proxy
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

把 `YOUR_USER` 換成新 VM 上的使用者（例如你建 VM 時登入的帳號；若還原到 `/home/washfacecatgm/invoice-proxy` 則 User=washfacecatgm）。

```bash
sudo systemctl daemon-reload
sudo systemctl enable giveme-proxy
sudo systemctl start giveme-proxy
sudo systemctl status giveme-proxy
```

---

## 三、更新 Giveme 白名單與本專案設定

1. **Giveme 後台**：把白名單 IP 從 136.115.207.151 改為新 VM 的靜態 IP（或兩顆都先留著再切換）。
2. **set-env.sh**：  
   - `GIVEME_PROXY_URL=http://新靜態IP:8080/invoice`  
   - `GIVEME_PICTURE_PROXY_URL=http://新靜態IP:8080/invoice-picture`（若中繼有支援發票圖路徑）
3. 重新部署 Cloud Run：`./deploy-line-webhook.sh`

---

## 四、檢查清單

- [ ] 舊 VM 已備份 `/home/washfacecatgm/invoice-proxy` 並下載到本機
- [ ] 已記錄舊 VM 上 Node 的啟動指令（`node app.js`）與是否有 systemd/pm2
- [ ] 新 VM 已建立、已綁定靜態 IP、防火牆 8080 已開
- [ ] 新 VM 已安裝 Node、解壓程式、`npm install`、手動跑過可聽 8080
- [ ] 新 VM 已設 systemd 開機自動啟動
- [ ] Giveme 白名單已改為新 IP
- [ ] set-env.sh 已改為新 IP 並重新部署 Cloud Run
- [ ] 實際開單／列印測試通過後，再考慮關閉或刪除舊 VM（136.115.207.151）

舊 VM 實際路徑：`/home/washfacecatgm/invoice-proxy`，入口：`app.js`，執行帳號：washfacecatgm。
