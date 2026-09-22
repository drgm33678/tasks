@README.md

## 給 Claude 的開發備註

- 使用者用繁體中文溝通,回覆一律用繁體中文
- repo 是公開的:不要把任何網址金鑰、Token、Chat ID 寫進程式碼或 commit
- `apps-script/Code.gs` 只是備份,改完要提醒使用者貼回 Apps Script 並「新版本」重新部署;
  使用者若在 Apps Script 編輯器直接改過,先請他貼最新版再動
- 日報有兩份實作要保持一致:`send-digest.js` 的 `buildDaily`(GitHub Actions)與 `index.html` 的 `buildDigest`(「傳送今日摘要」按鈕)
- 資料格式由三方共用(網站、Apps Script、send-digest.js),改欄位或刪除紀錄格式時三邊都要檢查;
  網站的合併邏輯依賴 `updatedAt`、`_ft`(欄位修改時間)、`_sheet` / `_sheetAt`(表格同步快照)
- 這台電腦沒有 node / python:測試時用 PowerShell HttpListener 開本機伺服器,在瀏覽器面板用 JS 執行被測函式
- 推送到 `main` 前先徵求使用者同意;推送後 GitHub Pages 約 30 秒~1 分鐘更新
