#!/usr/bin/env bash
# 已改為「只靠 Core 程式庫、不再複製到各專案」
# 專案 2～9 的 appsscript.json 已掛 Core 程式庫，請用 Core.getCoreConfig()、Core.jsonResponse() 等呼叫。
# 維護共用程式碼請在 PaoMao_Core 內修改，並在 Apps Script 將 Core 專案「部署為程式庫」後，各專案即可使用新版本。

set -e
echo "已改為僅依賴 Core 程式庫，不再複製檔案到各專案。"
echo "請在 PaoMao_Core 維護程式碼，並在 Apps Script 將 Core 專案部署為程式庫（或使用 developmentMode 即時更新）。"
