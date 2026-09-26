# SHHer — 急診醫學住院醫師 CBME 評核系統

## 專案概況
- 整個系統只有一個檔案 `index.html`（HTML + CSS + JS 全在裡面），由 GitHub Pages 從 `main` 分支發布。
- 資料存在 Firebase Firestore，透過 REST API 存取（不用 SDK），設定在 `FB_CONFIG`。
- 使用者：主治醫師（多半用手機填評核）、系統管理員（密碼登入後可見進階功能）。
- 使用者在手機上審閱你的修改，也不一定會讀程式碼。

## 每次修改的硬性規則
1. 只在現有的 `index.html` 上修改，不可整個重寫或分段重建。
2. `openM()`、`closeM()`、`toggleMode()`、`applyMode()` 是核心函數，絕對不能遺失。
3. 推送前必須：
   - 抽出 `<script>` 內容，用 `node --check` 驗證語法；
   - 執行 `node smoke_test.js index.html`，必須全部通過。
   新功能或修 bug 時，在 `smoke_test.js` 補上對應的測試情境。
4. 使用者一次提出多項需求時，一批最多 3–4 項；一批完成並經使用者確認後再做下一批。
5. 每次改版：側邊欄 `sb-tag` 與 `<title>` 的版本號加 0.01（目前 v5.26）；commit 訊息格式為「vX.XX 改了什麼」。
6. 推送後用繁體中文、白話說明：改了什麼、可能影響誰、使用者該怎麼驗證。
7. 不要把個資、病歷號、金鑰或密碼寫進 commit 訊息、PR 說明或新檔案（這個 repo 是公開的）。

## 資料與同步的設計（不要改回舊做法）
- **學員以姓名辨識。** 單字母代碼（A/B/F…）只在解析班表時使用，而且只比對在職（非畢業）學員。比對不到或同時符合多人時，略過該欄並回報原因，絕不按欄位位置猜。
- 內部 `id` 串起評核、班表與 CCC 紀錄，不可更改。改名只改 `n`。
- 同名視為同一人：新增時擋下重複姓名；已存在的同名重複用 `mergeDupResidents()` 合併。
- **雲端是名單的唯一依據。** `DEF_RES` / `DEF_ATT` 只用來初始化空資料庫、補回遺失的姓名。不可再用它們重建名單，否則刪掉的人會復活、畢業生的代碼會被填回。
- **差異同步。** `autoSync()` 只上傳和 `SYNC_BASE`（上次同步時的雲端快照）不同的部分：逐筆 residents / attendings、班表逐日（`config/schedule` 的 `data.<日期>`）、設定逐欄（`config/cfg`）。不可恢復「整批上傳 RES / ATT / SCHED / CFG」，那會讓舊裝置覆蓋別人的新資料。
- 修改本機資料後呼叫 `save()` 即可，它會自動排程差異上傳。
- 評核用 `saveCloud()` / `deleteAssessCloud()`；失敗會進 `PENDING_ASSESS` 佇列自動重試，不可改回靜默失敗。
- **評核增量下載。** `syncDown()` 透過 `pullAssessments()` 只查 `upd` / `id` 大於上次同步點的評核（`:runQuery`），刪除靠 `config/assessDel` 的刪除紀錄；首次、每 7 天、或按「完整重新下載」才讀全部。每次上傳要經 `pushAssess()`（寫 `upd`），刪除要經 `pushAssessDelete()`（先寫刪除紀錄）。不可改回每次開頁下載全部評核。
- `syncDown()` 用三方合併（`merge3Records` / `merge3Map`）：本機尚未上傳的修改保留，其餘以雲端為準。
- Firestore 免費額度每日 2 萬次寫入；任何可能大量寫入的改動都要先說明預估寫入量。

## 測試
- `smoke_test.js` 內含一個記憶體中的 Firestore REST 模擬器，會重播多裝置同步、班表比對、合併等情境。
- 用法：`node smoke_test.js index.html`，最後一行需為「✅ N passed, 0 failed」。
