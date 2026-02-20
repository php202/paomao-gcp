# Giveme 電子發票 API 說明（給 Giveme 窗口確認用）

我們從 **Cloud Run（固定出口 IP：35.221.242.144）** 直連貴司 API，目前連線在約 40 秒內無回應而逾時。  
請協助確認：  
1）此 IP 是否已在貴司白名單且已生效；  
2）以下 API 規格是否為貴司接受之格式。

---

## 一、我們呼叫的 API

### 開立發票（B2C）

- **URL**：`https://www.giveme.com.tw/invoice.do?action=addB2C`
- **Method**：`POST`
- **Content-Type**：`application/json`
- **Body（JSON）** 欄位說明：

| 欄位 | 型別 | 說明 |
|------|------|------|
| timeStamp | string | 當前時間毫秒字串（e.g. 1708412400000） |
| uncode | string | 統一編號（店家） |
| idno | string | 貴司提供之帳號 |
| sign | string | 簽名：MD5(timeStamp + idno + password)，大寫 |
| customerName | string | 選填，買方名稱 |
| datetime | string | 發票日期 yyyy-MM-dd |
| state | string | 固定 "0" |
| totalFee | string | 總金額（整數字串） |
| content | string | 備註（發票備註欄） |
| items | string | 明細之 **JSON 字串**，例：`[{"name":"商品名","money":100,"number":1}]` |
| phone | string | 選填，B2C 為手機條碼（e.g. /1234567） |
| orderCode | string | 選填，編號載具 |

### 開立發票（B2B）

- **URL**：`https://www.giveme.com.tw/invoice.do?action=addB2B`
- **Method**：`POST`
- **Content-Type**：`application/json`
- **Body（JSON）** 與 B2C 類似，另含：

| 欄位 | 說明 |
|------|------|
| phone | 買方統編（8 碼，必填） |
| taxState | 固定 "0" |
| totalFee | 總金額（含稅）字串 |
| amount | 稅額字串 |
| sales | 銷售額字串 |

### 發票圖片

- **URL**：`https://www.giveme.com.tw/invoice.do?action=picture`
- **Method**：`POST`
- **Content-Type**：`application/json`
- **Body**：含 timeStamp, uncode, idno, sign, code, type 等（依貴司文件）。

---

## 二、連線來源

- **目前出站 IP**：**35.221.242.144**（GCP Cloud Run 經 VPC + Cloud NAT 之固定出口 IP）
- **現象**：從此 IP 發出的請求在約 40 秒內未收到貴司回應即逾時（TCP 連線可能未建立或貴司未回傳）。
- **請協助確認**：  
  - 35.221.242.144 是否已加入貴司白名單且已生效？  
  - 貴司端是否有收到由此 IP 發出的連線或請求？若有，是否有錯誤或阻擋？

若貴司僅接受特定格式或另有白名單／防火牆規則，請告知，我們可配合調整。

---

## 三、與 VM 中繼的關係

我們另有一版「VM 中繼」架構：由 VM（例如過去 136.115.207.151）代轉請求至貴司，  
對貴司而言僅差在 **連線來源 IP 為 VM 的固定 IP**，**API URL、Method、Body 格式皆與上述相同**。  
若貴司已對某 VM IP 開通白名單，我們亦可改由該 VM 轉發；目前優先希望確認 **35.221.242.144** 是否可正常連線。
