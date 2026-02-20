// Invoice.gs
// 優先由 GCP /core 代開（固定出口 IP）；未設 GCP_CORE_API_URL 時才走 VM 中繼（已棄用）
function issueInvoice(storeInfo, odooNumber, buyType, items) {
  const gcp = typeof getGcpCoreApiParams !== "undefined" ? getGcpCoreApiParams() : { url: "", key: "" };
  if (gcp.url && gcp.key) {
    const odoo = String(odooNumber || "");
    const company = (storeInfo && storeInfo.companyName) ? String(storeInfo.companyName) : "";
    const itemCount = Array.isArray(items) ? items.length : 0;
    console.log("[issueInvoice] GCP Core 請求 odooNumber=%s buyType=%s company=%s items=%s", odoo, String(buyType || "請款"), company, itemCount);
    try {
      const payload = JSON.stringify({
        key: gcp.key,
        action: "issueInvoice",
        storeInfo: storeInfo || {},
        odooNumber: odoo,
        buyType: String(buyType || "請款"),
        items: Array.isArray(items) ? items : []
      });
      const res = UrlFetchApp.fetch(gcp.url, { method: "post", contentType: "application/json", payload: payload, muteHttpExceptions: true });
      const responseCode = res.getResponseCode();
      const responseText = res.getContentText();
      if (responseCode !== 200) {
        console.error("[issueInvoice] GCP Core HTTP %s body=%s", responseCode, responseText ? responseText.slice(0, 500) : "");
      }
      const json = JSON.parse(responseText);
      const data = (json && json.data) ? json.data : json;
      if (data && data.success === "true") {
        console.log("[issueInvoice] GCP Core 成功 code=%s", data.code || "");
      } else {
        console.warn("[issueInvoice] GCP Core 回傳非成功 success=%s msg=%s", (data && data.success) || "", (data && data.msg) || responseText.slice(0, 300));
      }
      return data;
    } catch (e) {
      const errMsg = (e && e.message) ? e.message : String(e);
      console.error("[issueInvoice] GCP Core 連線異常 odooNumber=%s error=%s stack=%s", odoo, errMsg, (e && e.stack) ? e.stack.slice(0, 400) : "");
      return { success: "false", msg: "GCP Core 連線異常: " + errMsg };
    }
  }

  const giveme = getGivemeConfig();
  if (!giveme.VM_PROXY_URL) {
    return { success: "false", msg: "請在指令碼屬性設定 GCP_CORE_API_URL 與 GCP_CORE_SECRET_KEY（或 PAO_CAT_CORE_API_URL / PAO_CAT_SECRET_KEY）" };
  }

  const totalAmount = items.reduce((sum, item) => sum + (item.money * item.number), 0);
  const sales = Math.round(totalAmount / 1.05);
  const taxAmount = totalAmount - sales;
  const timeStamp = new Date().getTime().toString();
  const finalContent = odooNumber ? `${buyType} (單號:${odooNumber})` : buyType;
  const invoiceData = {
    timeStamp: timeStamp,
    uncode: giveme.UNCODE,
    idno: giveme.IDNO,
    sign: generateMD5Sign(timeStamp + giveme.IDNO + giveme.PASSWORD),
    customerName: storeInfo.companyName,
    phone: String(storeInfo.pinCode || "").trim(),
    datetime: Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd"),
    email: storeInfo.email || "",
    taxState: "0", totalFee: totalAmount.toString(), amount: taxAmount.toString(), sales: sales.toString(),
    content: finalContent,
  };
  if (items && items.length > 0) {
    invoiceData.items = JSON.stringify(items);
  }

  try {
    console.log("[issueInvoice] VM 中繼 odooNumber=%s company=%s totalFee=%s", odooNumber, storeInfo.companyName, invoiceData.totalFee);
    const options = { method: "post", contentType: "application/json", payload: JSON.stringify(invoiceData), muteHttpExceptions: true };
    const response = UrlFetchApp.fetch(giveme.VM_PROXY_URL, options);
    const responseText = response.getContentText();
    const code = response.getResponseCode();
    if (code !== 200) {
      console.error("[issueInvoice] VM 中繼 HTTP %s body=%s", code, responseText ? responseText.slice(0, 500) : "");
    }
    const out = JSON.parse(responseText);
    if (out && out.success === "true") {
      console.log("[issueInvoice] VM 中繼 成功 code=%s", out.code || "");
    } else {
      console.warn("[issueInvoice] VM 中繼 回傳 success=%s msg=%s", (out && out.success) || "", (out && out.msg) || responseText.slice(0, 300));
    }
    return out;
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    console.error("[issueInvoice] VM 中繼 連線異常 odooNumber=%s error=%s stack=%s", odooNumber, errMsg, (e && e.stack) ? e.stack.slice(0, 400) : "");
    return { success: "false", msg: "API 連線異常: " + errMsg };
  }
}

function generateMD5Sign(input) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, input, Utilities.Charset.UTF_8);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('').toUpperCase();
}