# 排程項目

個人用的需求 / 排程追蹤網站:<https://drgm33678.github.io/tasks>

- 網站上新增、編輯需求,資料存在自己的 Google 雲端硬碟,換電腦、重開機都不會遺失
- KR / DY / LJ 三個系統的 Google 表格每 5 分鐘自動同步進來
- 每天、每週自動把日報推到 Telegram;需求變成「阻塞」時立即通知

---

## 1. 使用的工具與用途

| 工具 | 做什麼 | 在哪裡管理 |
|---|---|---|
| **GitHub repo** | 存放所有程式碼(網站、日報程式、Apps Script 備份) | <https://github.com/drgm33678/tasks>;本機在 `文件\tasks` |
| **GitHub Pages** | 把 `index.html` 變成網站。推送到 `main` 後約 30 秒~1 分鐘自動更新 | repo → Settings → Pages |
| **GitHub Actions** | 定時執行 `send-digest.js`:每天 09:00 日報、每週一 10:00 追蹤清單 | repo → Actions |
| **GitHub Secrets** | 保存 Actions 要用的密鑰(不會出現在程式碼裡) | repo → Settings → Secrets and variables → Actions |
| **Google Apps Script** | 雲端後端:① 讓網站讀寫資料 ② 每 5 分鐘同步 Google 表格 ③ 表格改成阻塞時推 Telegram | Apps Script「排程項目同步」專案;程式碼備份在 `apps-script/Code.gs` |
| **Google 雲端硬碟** | 實際存放資料的檔案「排程項目資料.json」(雲端硬碟會自動保留歷史版本) | 雲端硬碟 |
| **Google 表格** | KR / DY / LJ 各自的需求表,Apps Script 讀取後同步到網站 | 各系統的表格 |
| **Telegram Bot** | 接收日報、每週清單、阻塞通知、備份檔 | Telegram(@BotFather 管理機器人) |

### 資料怎麼流動

```
                ┌──────────── 讀寫資料(需要存取金鑰)────────────┐
  網站(GitHub Pages) ◀──────────────────────────────▶ Apps Script ◀──▶ 雲端硬碟「排程項目資料.json」
      │ 阻塞立即通知(網站上改的)                         ▲   │
      ▼                                                  │   └── 阻塞通知(表格改的)──▶ Telegram
   Telegram ◀── 日報 / 每週清單 ── GitHub Actions ──讀資料─┘
                                                         ▲
                    KR / DY / LJ Google 表格 ──每 5 分鐘同步──┘
```

---

## 2. 檔案說明

| 檔案 | 內容 |
|---|---|
| `index.html` | 整個網站(畫面、雲端同步、Telegram 通知、備份還原)都在這一個檔案 |
| `send-digest.js` | 日報與每週清單的程式,由 GitHub Actions 執行 |
| `.github/workflows/daily-digest.yml` | 每日日報排程(另含「60 天沒 commit 自動補一筆」讓排程不被 GitHub 停用) |
| `.github/workflows/weekly-followup.yml` | 每週一追蹤清單排程 |
| `apps-script/Code.gs` | Apps Script 程式碼的**備份**。改了這個檔案不會自動生效,要貼回 Apps Script 並重新部署 |
| `.github/keepalive.txt` | 自動產生,不用理它 |

---

## 3. 通知規則

所有通知都發到同一個 Telegram 對話。

### 每日日報
- **時間**:每天台灣 09:00(GitHub 常延遲 10~30 分鐘)。網站「傳送今日摘要」按鈕可手動發,格式相同
- **內容**:
  - 最上方 🔥 **重要(需即時處理)**:網站上標為重要、狀態不是暫停開發或已上線的需求(跨系統,依 系統 → 順位 → 優先級 排序,只附剩餘天數)
  - 接著依 KR → DY → LJ → 未分系統分組,每組列出:
    - 各狀態件數(0 件、**已上線**、**暫停開發**不列)
    - ⚠️ 即將到期 / 逾期:有「預計上線日」且剩 **2 天內**或已逾期(已上線、暫停開發除外)
    - 🚧 阻塞中:附「技術回復」第一行
- 全部都沒有重要、逾期或阻塞時顯示「✅ 一切順利」

### 每週技術追蹤清單
- **時間**:每週一台灣 10:00
- **列入條件**(同時符合):
  1. 狀態是 待評估 / 未釐清 / 釐清中 / 開發中 / 待測試
  2. 有優先級(P0/P1/P2)或順位
  3. 超過 **7 天**沒有任何變動
- 依系統分組,組內依 順位 → 優先級 → 提交日期 排序

### 🔥 重要(需即時處理)
- 網站上勾選表單的「重要(需即時處理)」,或按卡片上的「🔥 設為重要」;KR / DY / LJ 任何系統的需求都可以標
- 左側「🔥 重要」分類列出所有標為重要、狀態不是暫停開發或已上線的需求;自動排序時排在最前面
- 狀態改成**暫停開發**或**已上線**後自動不再列入(標記保留,改回其他狀態會再出現);要提早移除按「取消重要」
- 每天的日報最上方會列出(見上方「每日日報」)
- 標記只在網站上設定,Google 表格同步不會改動它

### 👀 追蹤紀錄
- 卡片上按「👀 追蹤」記一筆(日期 + 操作人),每催一次進度就按一次
- 有追蹤過的卡片會顯示「已追蹤 N 次 · 最後 9/26 20:50(今天)」,點它展開每一次的日期與是誰追的
- 按錯可在展開後按「取消最後一筆」;追蹤與取消也會寫進修改紀錄
- 所有人共用,會同步到雲端;每筆最多保留 50 次
- 不影響日報、機器人與左側分類

### 🔎 Telegram 查詢機器人
- 在日報的群組裡輸入 `/ask 關鍵字`,或**回覆機器人的訊息**再查;只查詢,不會修改資料
  - 編號:`/ask 234`(只顯示編號完全相同的那筆)
  - 標題關鍵字:`/ask 國慶休市`(繁體、簡體都查得到)
  - 組合條件:`/ask KR 逾期`、`/ask Amy 開發中`、`/ask 重要`、`/ask 阻塞`、`/ask P0`
- 多個關鍵字用空格分開,全部符合才列出;比對 編號、標題、系統、狀態、PM、需求單位、平台、類別、描述、技術回復、GM 備註,以及 重要 / 逾期 / 即將到期 標籤
- 符合 3 筆以內顯示詳細進度(狀態、預計上線與剩餘天數、PM、最後更新、狀態紀錄、技術回復、GM 備註);更多筆顯示清單(最多 15 筆)
- 只回應網站「Telegram 通知」設定的那個對話;不需要任何費用
- 程式在 `apps-script/Code.gs` 最下方「Telegram 查詢機器人」,可調整 `BOT` 裡的筆數

### 阻塞立即通知
| 在哪裡改成阻塞 | 誰發通知 | 多快 |
|---|---|---|
| 網站上 | 做修改的那台裝置 | 立即 |
| Google 表格 | Apps Script | 下次同步(最多 5 分鐘) |

- 網站「Telegram 通知 → 阻塞立即通知」關掉時,兩種都不發
- 同一筆一直是阻塞不會重複通知;改回其他狀態不通知

---

## 4. 設定值存在哪裡

### GitHub Secrets(repo → Settings → Secrets and variables → Actions)
| 名稱 | 內容 |
|---|---|
| `GAS_URL` | Apps Script Web App 網址(`https://script.google.com/macros/s/…/exec`) |
| `GAS_TOKEN` | Apps Script 存取金鑰 |
| `TELEGRAM_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 接收通知的 Chat ID |

### Apps Script 指令碼屬性(專案設定 → 指令碼屬性)
| 名稱 | 內容 |
|---|---|
| `SHEET_KR` / `SHEET_DY` / `SHEET_LJ` | 各系統表格的 ID(網址中 `/d/` 與 `/edit` 之間那串) |
| `SHEET_KR_NAME` …(選填) | 工作表分頁名稱,不填用第一個分頁 |
| `ACCESS_TOKEN` | 存取金鑰(自動產生) |
| `WEBAPP_URL` | 查詢機器人用:部署的 Web App 網址(`/exec` 結尾,和 GitHub Secret `GAS_URL` 相同)。程式自己抓到的是開發用 `/dev` 網址,Telegram 連不進去,所以要手動填 |
| `TG_WEBHOOK_SECRET`、`TG_BOT_USERNAME` | 查詢機器人自動維護,**不要手動改** |
| `FILE_ID`、`REV`、`SHEET_HASH_*` | 程式自動維護,**不要手動改** |

### 網站(存在各自的瀏覽器裡)
- **雲端同步**:Web App 網址 + 存取金鑰(或「同步碼」,兩者打包成一串)
- **操作人**(必填):名字,記在修改紀錄裡。沒填時,新增、編輯、改狀態、設為重要、刪除、復原、拖曳排序、切換排序、匯入備份、傳送 Telegram(摘要、測試、備份)、儲存 Telegram 設定都不能操作;瀏覽、搜尋、篩選、下載備份、雲端連線不受限
- **Telegram 通知**:Bot Token、Chat ID、阻塞立即通知開關 → 這些會同步到雲端,所有裝置共用,Apps Script 的表格阻塞通知也用這組
- 「自動提醒」請保持**關閉**(日報已由 GitHub Actions 發,開著會重複)

---

## 5. 常用操作

### 修改網站或日報(`index.html`、`send-digest.js`)
改好推到 GitHub `main` → 網站約 1 分鐘後更新(已開著的網頁要重新整理);日報從下一次排程開始用新版。

### 修改 Apps Script(`apps-script/Code.gs`)
1. 把 `apps-script/Code.gs` 全部內容貼到 Apps Script 編輯器,取代原本的程式碼
2. 部署 → 管理部署作業 → 編輯(鉛筆)→ 版本選「新版本」→ 部署(網址不變,其他地方都不用改)
   ⚠ 先按💾儲存程式碼再部署;專案裡有多個部署時,要更新的是網站與日報在用的那一個(指令碼屬性 `WEBAPP_URL` 的網址);「版本」欄是灰色時,要先按右上角的鉛筆才能改
3. 手動執行一次 `syncNow`,看執行記錄有沒有錯誤
4. 如果新功能需要新權限,第一次執行時 Google 會要求授權,按允許

### Apps Script 裡可以手動執行的函式
| 函式 | 用途 |
|---|---|
| `syncNow` | 立即同步一次 Google 表格 |
| `resetSyncState` | 讓下一次同步重新比對整張表(表格沒變但想強制重跑時用) |
| `installTrigger` / `removeTrigger` | 開啟 / 停止每 5 分鐘自動同步 |
| `showAccessToken` | 在執行記錄顯示存取金鑰 |
| `rotateAccessToken` | 換新金鑰(舊的立即失效,之後要更新網站與 GitHub Secret `GAS_TOKEN`) |
| `setup` | 第一次設定用,已完成,不需要再執行 |
| `setupTelegramBot` | 啟用查詢機器人(換 Bot Token 或部署網址後也要重跑) |
| `removeTelegramBot` | 停用查詢機器人 |
| `checkTelegramBot` | 查看機器人連線狀態(`last_error_message` 出現「302 Found」是 Apps Script 的正常現象,可忽略) |
| `diagnoseTelegramBot` | 機器人沒反應時:先在群組傳 `/ask 234` 再執行,會列出訊息來自哪個對話、是否被當成查詢,並送一則測試訊息 |

### 手動發日報 / 每週清單
repo → Actions → 選「Daily Telegram Digest」或「Weekly Follow-up List」→ Run workflow。

### 改發送時間
改 `.github/workflows/*.yml` 裡的 `cron`。cron 用 UTC,**台灣時間 − 8 小時**,例:台灣 18:00 → `'0 10 * * *'`。

### 新裝置 / 新瀏覽器連線
打開網站 → 雲端同步 → 貼上「同步碼」→ 連線。同步碼在已連線的裝置上「雲端同步」區塊可以複製。
⚠ 同步碼就是資料的鑰匙,不要外流。懷疑外洩時執行 `rotateAccessToken`。

### 備份與還原
- 雲端硬碟會自動保留資料檔的歷史版本
- 網站「備份與還原」可把備份傳到 Telegram 或下載(備份檔不含 Bot Token)
- 刪除的需求在「最近刪除」保留 60 天,可復原

---

## 6. 可以調整的參數

| 想調整 | 檔案 | 位置 |
|---|---|---|
| 日報到期提醒天數(目前 2 天) | `send-digest.js`、`index.html` | `x.d <= 2` |
| 每週清單「久未更新」天數(目前 7 天) | `send-digest.js` | `STALE_DAYS` |
| 每週清單納入的狀態 | `send-digest.js` | `WEEKLY_STATUSES` |
| 不算逾期、日報不列件數的狀態 | `send-digest.js`、`index.html` | `NO_OVERDUE` |
| 發送時間 | `.github/workflows/*.yml` | `cron` |
| 表格同步頻率(目前 5 分鐘) | `apps-script/Code.gs` | `SYNC.INTERVAL_MINUTES`(改完要重新執行 `installTrigger`) |
| 平台不併入「裝置」的系統(目前 LJ) | `apps-script/Code.gs` | `SYNC.SKIP_DEVICE` |
| 表格欄位名稱對應 | `apps-script/Code.gs` | `HEADER_ALIASES` |
| 表格狀態文字對應 | `apps-script/Code.gs` | `STATUS_MAP` |
| 刪除保留天數(目前 60 天) | `index.html` | `TOMBSTONE_DAYS` |
| 網站抓取其他人修改的頻率(目前 3 分鐘) | `index.html` | `PULL_MS` |

**新增系統(例如第四個系統)** 需要同時改多處:`index.html` 的 `SYSTEMS` 與表單選項、`send-digest.js` 與 `index.html` 裡的 `SYSTEM_ORDER` / `(KR|DY|LJ)`、`apps-script/Code.gs` 的 `SYNC.SYSTEMS` 與 `(KR|DY|LJ)`,再加上指令碼屬性 `SHEET_新系統`。

---

## 7. 故障排除

| 狀況 | 先檢查 |
|---|---|
| 網站顯示「未連線雲端」 | 雲端同步區的網址 / 金鑰是否正確;金鑰換過的話要貼新的同步碼 |
| 網站顯示「備份失敗…秒後自動重試」 | 通常是網路或 Google 暫時問題,會自動重試;先不要關頁面 |
| 沒收到日報 | repo → Actions 看最近一次執行是否紅色失敗,點進去看錯誤訊息 |
| 表格改了網站沒變 | Apps Script → 執行項目,看 `syncNow` 的記錄;或手動執行 `syncNow` |
| 查詢機器人沒回應 | 執行 `setupTelegramBot` 或 `checkTelegramBot`,會檢查那個網址是不是跑著新版程式碼(常見原因:更新到別的部署了);再不行就在群組傳 `/ask 234` 後執行 `diagnoseTelegramBot`;Apps Script → 執行項目 看 `doPost` 的錯誤;換過 Bot Token 要重跑 `setupTelegramBot` |
| 網站「測試連線」抓不到 Chat ID | 啟用查詢機器人後 Telegram 不允許用這種方式抓,請手動填 Chat ID |
| 表格阻塞沒通知 | `syncNow` 記錄是否有「已推送阻塞通知」或「略過」的原因 |
| Actions 排程停了 | 公開 repo 60 天沒 commit 會被停用;daily 排程會自動補 commit,若仍停用到 Actions 頁面重新啟用 |

---

## 8. 以後要找 Claude 調整時

1. 在 Claude Code 開啟本機資料夾 `文件\tasks`(Claude 會自動讀這份說明)
2. 直接描述想改什麼,例如「日報的到期提醒改成 3 天」「每週清單加上阻塞的項目」
3. 改 Apps Script 的話,Claude 會更新 `apps-script/Code.gs`,你再照「5. 常用操作」貼回並部署
4. 如果你直接在 Apps Script 編輯器改過程式碼,記得先把最新版貼給 Claude,避免被 repo 裡的舊備份蓋掉

> 這個 repo 是**公開**的,程式碼裡不能放任何密鑰;密鑰一律放 GitHub Secrets 或 Apps Script 指令碼屬性。
