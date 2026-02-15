function totalMoney() {
  const token = Core.getBearerTokenFromSheet();
  const year = new Date().getFullYear();
  const url = `https://saywebdatafeed.saydou.com/api/management/analytics/yearPerformance?year=${year}`;
  const options = {
    method: 'GET',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`
    },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(response.getContentText());
  const stores = data.data.performanceData;
  console.log(stores)

  var ssId = typeof CONFIG !== "undefined" && CONFIG.INTEGRATED_SHEET_SS_ID ? CONFIG.INTEGRATED_SHEET_SS_ID : null;
  var ss = ssId ? SpreadsheetApp.openById(ssId) : null;
  if (!ss) throw new Error("無法取得試算表");
  const writeSheet = ss.getSheetByName("門市業績狀態");
  writeSheet.clearContents();
  const months = stores[0].series.map(item => item.name);
  const header = ["店名", ...months];
  writeSheet.getRange(1, 1, 1, header.length).setValues([header]);

  // 寫入每一間店的資料
  stores.forEach((store, i) => {
    const row = [store.name, ...store.series.map(s => s.value)];
    writeSheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
  });

  const dataRange = writeSheet.getDataRange();
  const values = dataRange.getValues();
  const headers = values[0].slice(1); // 1月 ~ 12月
  const storeData = values.slice(1);  // 去掉表頭
  const buckets = [
    { label: "30以下",      check: v => v < 300000 },
    { label: "30-40",       check: v => v >= 300000 && v < 400000 },
    { label: "40-50",       check: v => v >= 400000 && v < 500000 },
    { label: "50-60",       check: v => v >= 500000 && v < 600000 },
    { label: "60以上",      check: v => v >= 600000 }
  ];

  const result = [];
  // 每一個區間
  for (let bucket of buckets) {
    const row = [];
    for (let col = 1; col <= headers.length; col++) {
      let count = 0;
      for (let r = 1; r < values.length; r++) {
        const val = values[r][col];
        if (typeof val === 'number' && bucket.check(val)) {
          count++;
        }
      }
      row.push(count);
    }
    result.push([bucket.label, ...row]);
  }
  // 寫入區間統計（從底部下一行寫入）
  const outputStartRow = values.length + 2;
  const outputStartCol = 1;
  const bucketHeader = ["分類區間", ...headers];
  writeSheet.getRange(outputStartRow, outputStartCol, 1, bucketHeader.length).setValues([bucketHeader]);
  writeSheet.getRange(outputStartRow + 1, outputStartCol, result.length, bucketHeader.length).setValues(result);
}
