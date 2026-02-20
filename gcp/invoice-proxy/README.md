# Giveme 中繼 VM（invoice-proxy）

Cloud Run 開單／發票圖經此 VM 轉發到 Giveme，以通過 IP 白名單。

- **POST /invoice** → Giveme addB2C / addB2B（開單）
- **POST /invoice-picture** → Giveme action=picture（發票圖片）

---

## 步驟一：保留固定 IP（同一專案）

在本機（已 `gcloud auth login` 且專案正確）執行：

```bash
export PROJECT_ID=gen-lang-client-0828139766   # 改成你的專案
export REGION=asia-east1
export STATIC_IP_NAME=giveme-proxy-ip

gcloud compute addresses create $STATIC_IP_NAME --region=$REGION --project=$PROJECT_ID
```

查詢剛保留的 IP（待會填 Giveme 白名單與 set-env.sh）：

```bash
gcloud compute addresses describe $STATIC_IP_NAME --region=$REGION --project=$PROJECT_ID --format="get(address)"
```

記下輸出的 IP（例如 `34.80.xxx.xxx`）。

---

## 步驟二：建立 VM 並綁定該固定 IP

```bash
export ZONE=asia-east1-b
export VM_NAME=giveme-proxy

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

（若上一步用 `--region` 保留 IP，這裡的 `address=$STATIC_IP_NAME` 會自動用該區的保留 IP。）

---

## 步驟三：開放防火牆 8080

```bash
gcloud compute firewall-rules create allow-giveme-proxy-8080 \
  --project=$PROJECT_ID \
  --allow=tcp:8080 \
  --target-tags=giveme-proxy \
  --source-ranges=0.0.0.0/0
```

---

## 步驟四：SSH 進 VM 並安裝 Node、部署程式

```bash
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT_ID
```

在 **VM 內** 執行：

```bash
# 安裝 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 建立目錄（用你 SSH 登入的帳號，例如 paopaomao_of）
mkdir -p ~/invoice-proxy
```

**在本機** 把專案裡的 invoice-proxy 程式傳到 VM（不含 node_modules，到 VM 再 npm install）：

```bash
cd /Users/yutsunghan/node_express/gcp
tar -czvf /tmp/invoice-proxy-src.tar.gz --exclude=node_modules invoice-proxy/
gcloud compute scp /tmp/invoice-proxy-src.tar.gz $VM_NAME:/tmp/ --zone=$ZONE --project=$PROJECT_ID
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT_ID --command="cd ~ && tar -xzvf /tmp/invoice-proxy-src.tar.gz && ls -la invoice-proxy/"
```

回到 **VM 內**：

```bash
cd ~/invoice-proxy
npm install --production
node app.js
```

另開一個終端測試（把 VM_IP 換成步驟一查到的固定 IP）：

```bash
curl -X POST http://VM_IP:8080/invoice -H "Content-Type: application/json" -d '{}'
# 應有 JSON 回傳（可能錯誤沒差，代表有通）
```

VM 內按 Ctrl+C 停掉 node，繼續下一步。

---

## 步驟五：設成開機自動啟動（systemd）

在 **VM 內** 執行（`YOUR_USER` 改成你 SSH 登入的帳號，例如 `paopaomao_of`）：

```bash
export VM_USER=$(whoami)
sudo tee /etc/systemd/system/giveme-proxy.service << EOF
[Unit]
Description=Giveme Invoice Proxy
After=network.target

[Service]
Type=simple
User=$VM_USER
WorkingDirectory=/home/$VM_USER/invoice-proxy
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable giveme-proxy
sudo systemctl start giveme-proxy
sudo systemctl status giveme-proxy
```

應顯示 `active (running)`。

---

## 步驟六：Giveme 白名單與 set-env.sh

1. **Giveme 後台**：把 IP 白名單改成步驟一查到的 **固定 IP**（或新增該 IP）。
2. **set-env.sh**（本機專案）：

```bash
export GIVEME_PROXY_URL=http://固定IP:8080/invoice
export GIVEME_PICTURE_PROXY_URL=http://固定IP:8080/invoice-picture
```

3. **重新部署 Cloud Run**：

```bash
cd /Users/yutsunghan/node_express/gcp
source set-env.sh
./deploy-line-webhook.sh
```

---

## 檢查清單

- [ ] 步驟一：已保留固定 IP 並記下
- [ ] 步驟二：已建立 VM 並綁定該 IP
- [ ] 步驟三：已開防火牆 8080
- [ ] 步驟四：VM 已安裝 Node、已解壓程式、npm install、手動跑過 node app.js
- [ ] 步驟五：已設 systemd、giveme-proxy 為 active
- [ ] 步驟六：Giveme 白名單已改、set-env.sh 已填、已重新部署 Cloud Run
- [ ] 實際開單＋列印發票圖測試通過

## 常用指令

```bash
# 看 VM 狀態
sudo systemctl status giveme-proxy

# 重啟中繼
sudo systemctl restart giveme-proxy

# 看日誌
sudo journalctl -u giveme-proxy -f
```
