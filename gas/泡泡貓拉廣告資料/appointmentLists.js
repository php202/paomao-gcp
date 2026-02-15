/** 預約清單（動態）試算表 ID */
const AD_SS_ID = '19NWuiZ1hI0pC6_eMxsKvQlzcf5aGrs4OJgtOTJANjjQ';

function appointmentLists() {
  const ss = SpreadsheetApp.openById(AD_SS_ID);
  const sheet = ss.getSheetByName("預約清單（動態）");
  if (!sheet) throw new Error("找不到工作表：預約清單（動態）");

  const startDate = sheet.getRange('A2').getValue();
  const endDate = sheet.getRange('B2').getValue();
  if (!startDate || !endDate) {
    throw new Error("請在 A2、B2 填入開始與結束日期（例如 2026-02-01）");
  }

  // 1. 取得店家列表（透過 Core 中央 API，網路應用程式部署）
  const stores = CoreApi.getStoresInfo();
  if (!stores || stores.length === 0) {
    throw new Error("無法取得店家列表，請確認 PAO_CAT_CORE_API_URL 與 PAO_CAT_SECRET_KEY 已設定，且 Core API 有回傳店家。");
  }

  // 2. 清除第 5 列以下資料（保留第 1～4 列：標題與參數列）
  // getRange(row, column, numRows, numColumns)：從第 5 列起清除到最後一列
  const lastRow = sheet.getLastRow();
  if (lastRow >= 5) {
    const numRowsToClear = lastRow - 4;
    sheet.getRange(5, 1, numRowsToClear, sheet.getLastColumn()).clearContent();
  }

  // 設定日期比較基準
  const today = new Date();
  today.setHours(0,0,0,0);

  // 3. 準備寫入的資料容器
  let allOutputRows = [];

  // 4. 開始跑迴圈 (資料處理)
  for (let i = 0; i < stores.length; i++) {
    const currentStore = stores[i]; // 修正變數引用
    let data = {
      a: null,
      b: { old: 0, new: 0 }
    };

    try {
      // 呼叫外部 API 函式 (假設這兩個函式您已經定義好)
      data.a = CoreApi.fetchReservationData(startDate, endDate, currentStore.id);
      
      // 只有「過去或今天」才需要查新舊客 (未來通常還沒結帳無法判定，視您的邏輯而定)
      // 注意：這裡直接比較 Date 物件有時會有雷，建議轉 timestamp 或 yyyy-MM-dd 字串比較
      if (new Date(startDate) <= today) {
        data.b = CoreApi.oldNewA(startDate, endDate, currentStore.id);
      }
      
      // ★ 關鍵修改：cleanData 不再寫入，而是「回傳」整理好的一列資料
      const rowData = fetchData(currentStore.name, data);
      allOutputRows.push(rowData);
      
    } catch (e) {
      console.error(`店家 ${currentStore.name} 處理失敗: ${e}`);
      // 發生錯誤時塞入一行（欄數須與 fetchData 回傳一致：12 欄）
      allOutputRows.push([currentStore.name, "讀取失敗", "", "", "", "", 0, 0, "", "", "0%", "0%"]);
    }
  }

  // 5. 批次寫入 (效能優化)
  // getRange(row, column, numRows, numColumns) 第三參數是「列數」不是結束列號
  if (allOutputRows.length > 0) {
    sheet.getRange(5, 1, allOutputRows.length, allOutputRows[0].length).setValues(allOutputRows);
    console.log(`成功寫入 ${allOutputRows.length} 筆資料`);
  }
}

/**
 * 資料整理函式 (純計算，不寫入 Sheet)
 * @return {Array} 回傳整理好的一維陣列
 */
function fetchData(storeName, data) {
  // 輔助函式：安全取得數字
  const getTotal = (source) => {
    if (!data.a || !Array.isArray(data.a)) return 0; // 防呆
    const match = data.a.find(i => i.source === source);
    return match ? (parseInt(match.total) || 0) : 0;
  };

  // 1. 計算各來源數據
  const line = getTotal('line');
  const web2 = getTotal('web2');
  const phone = getTotal('phone');
  const google = getTotal('google');
  const pad = getTotal('pad');
  const ig = getTotal('instagram');
  const total = line + web2 + phone + google + pad + ig;

  // 2. 計算新舊客總數 (分母)；API 可能回傳 { new, old } 或陣列
  let newCount = 0, oldCount = 0;
  if (data.b && typeof data.b === "object") {
    if (Array.isArray(data.b) && data.b[0]) {
      newCount = data.b[0].new != null ? Number(data.b[0].new) : 0;
      oldCount = data.b[0].old != null ? Number(data.b[0].old) : 0;
    } else {
      newCount = data.b.new != null ? Number(data.b.new) : 0;
      oldCount = data.b.old != null ? Number(data.b.old) : 0;
    }
  }
  // 如果新+舊=0，分母設為 1 避免除以零 (或者讓百分比顯示 0%)
  const totalMemberOps = (newCount + oldCount) > 0 ? (newCount + oldCount) : 1; 

  // 3. 計算百分比 (轉字串)
  // 如果分母是有效值才計算，否則顯示 0%
  const newRate = (newCount + oldCount) > 0 ? ((newCount / totalMemberOps) * 100).toFixed(1) + '%' : '0%';
  const oldRate = (newCount + oldCount) > 0 ? ((oldCount / totalMemberOps) * 100).toFixed(1) + '%' : '0%';

  // 4. 回傳陣列 (Row Data)
  return [
    storeName,
    line,
    web2,
    phone,
    google,
    pad,
    ig,
    total, // Total
    newCount,
    oldCount,
    newRate,
    oldRate
  ];
}
