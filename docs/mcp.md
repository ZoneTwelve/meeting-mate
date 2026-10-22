# Meeting Mate MCP（本機 stdio）

MCP 是現有 Meeting Mate HTTP 服務的薄介面。它透過 stdin/stdout 接收 MCP JSON-RPC，每個工具只呼叫 `127.0.0.1:<healthPort>`。`healthPort` 由專案現有的 `loadConfig()` 讀取，預設 8787；`.env` 與 `MEETING_MATE_CONFIG` 的行為與主服務相同。MCP 不啟動 monitor、Chrome 或另一份錄影服務。

## 啟動與連接

先確保主服務已執行。需要啟動主服務時，在專案目錄執行：

```sh
pnpm run install:launchd
```

將以下設定放進支援 stdio 的 MCP client；`command` 的 Node 必須是 22 以上，GUI client 找不到 Node 時可改成其絕對路徑：

```json
{
  "mcpServers": {
    "meeting-mate": {
      "command": "node",
      "args": ["/absolute/path/to/meeting-mate/src/mcp.mjs"]
    }
  }
}
```

MCP client 會啟動這個子程序。手動啟動作協定測試也可以：

```sh
cd /absolute/path/to/meeting-mate
pnpm exec node src/mcp.mjs
```

程序會安靜等待 MCP 請求，不是互動式命令列。stdout 只輸出協定訊息，啟動錯誤寫到 stderr。若使用 package script `mcp`，請以 `pnpm --silent run mcp` 啟動，避免 pnpm 的 script banner 混入協定。關閉 MCP 連線只關閉此介面，錄影與 monitor 的生命週期由主服務管理。

## 工具

所有輸入物件都拒絕未宣告欄位。`url` 只接受有效 HTTPS Google Meet 會議連結；它是傳給服務的會議識別值，不是 HTTP client 的目的地。

| 工具 | 輸入 | HTTP API | 行為 |
| --- | --- | --- | --- |
| `meet_join` | 必填 `url` | `POST /v1/meetings/join` | 立即排隊加入，獲准後由服務錄影 |
| `meet_stop` | 可選 `url` | `POST /v1/meetings/stop` | 離開並完成目前錄影檔 |
| `meet_pause` | 可選 `url` | `POST /v1/meetings/pause` | 留在會議但暫停錄影 |
| `meet_resume` | 可選 `url` | `POST /v1/meetings/resume` | 恢復暫停中的錄影 |
| `meet_status` | 無 | `GET /healthz`、`GET /v1/meetings` | 回傳 `{health, meetings}` |
| `recordings_list` | 可選整數 `limit`，預設 50、範圍 1–100 | `GET /v1/recordings?limit=…` | 列出錄影 metadata |
| `recording_get` | 必填 `id` | `GET /v1/recordings/:id` | 讀取錄影 metadata 與服務提供的本機檔案／下載位置 |
| `recording_test_start` | 無 | `POST /v1/recording-tests`，body `{}` | 啟動服務管理的非同步本機影音測試 |
| `recording_test_status` | 可選 `id`，預設 `latest` | `GET /v1/recording-tests/:id` | 查詢測試進度與結果 |
| `recorder_diagnostics` | 無 | `GET /v1/diagnostics` | 讀取錄影器診斷資訊 |
| `transcript_create` | 必填 `recordingId`；可選 `language`、`numSpeakers`、`idempotencyKey` | `POST /v1/transcripts` | 建立或重用本機分講者逐字稿 job |
| `transcripts_list` | 可選整數 `limit`，預設 50、範圍 1–100 | `GET /v1/transcripts?limit=…` | 列出自動與手動產生的逐字稿 jobs |
| `transcript_get` | 必填 UUID `id` | `GET /v1/transcripts/:id` | 查詢狀態、結果、失敗原因與本機下載參照 |

`stop`／`pause`／`resume` 未提供 `url` 時，主服務選擇目前作用中的會議。MCP 不自行猜測會議狀態，也不會替換另一場正在錄影的會議。錄影與錄影測試的 `id` 必須取自 API 回應，只允許最多 255 個英數字、點、底線與連字號，並以英數字開頭；逐字稿 job 的 `id` 必須是 UUID。皆不接受檔案路徑、URL 或路徑跳脫。回傳的檔案或下載位置只是 metadata，MCP 不讀取或上傳影音檔案。

`meet_join` 回傳 `accepted: true, status: "queued"` 只表示請求被接受。接著呼叫 `meet_status` 確認等待批准、加入與錄影狀態；暫停、恢復、停止也應查詢狀態確認完成。顯示名稱沿用主服務 `.env` 的 `MEET_USERNAME`，MCP 工具不能改寫它。

`recording_test_start` 回傳測試 ID 後，使用 `recording_test_status` 查詢，直到 API 回報測試完成。此工具會建立測試產物，可能開啟本機測試畫面；不加入 Google Meet。主服務若正在忙碌會回報衝突。重複啟動可能建立新測試，不能視為冪等操作。

所有 POST 工具另接受可選 `idempotencyKey`，轉送為 HTTP `Idempotency-Key` header，不放進 JSON body。值可使用 1–128 個英數字、點、底線、冒號或連字號。重送同一操作時使用相同 key 與參數；新操作使用新 key。API 在同一服務程序內快取最多 200 個 keyed 請求、保留一小時；重啟、過期或容量淘汰後不再保證去重。相同 key 搭配不同路由或 body 會收到 409。MCP 本身不自動產生 key 或自動重試。

## 本機分講者逐字稿

會議 session 結束時的自動逐字稿由主服務觸發；MCP 不自行監看結束事件或啟動模型程序。透過 `transcripts_list` 可以找到自動建立的 job，再用 `transcript_get` 追蹤。語音辨識與講者分離由本機 worker 執行；MCP 不接受遠端音檔 URL、模型位置或任意檔案路徑。

手動處理舊錄影或重新嘗試失敗的工作時，先用 `recordings_list` 取得已完成驗證的錄影 ID，再呼叫：

```json
{
  "name": "transcript_create",
  "arguments": {
    "recordingId": "recording-001.mp4",
    "language": "zh",
    "numSpeakers": 2,
    "idempotencyKey": "transcript-request-001"
  }
}
```

`recording-001.mp4` 只是範例，必須改成 API 實際回傳的 ID。有 session 的錄影會處理同一個已結束 session 中的所有 verified 分段；舊版沒有 session 的錄影只處理選定檔案。分段選擇、工作去重、佇列與模型設定都由主服務管理。

`language` 接受 `auto` 或小寫 2–3 字母 ISO 語言代碼，例如 `en`、`zh`，不接受 `zh-TW`；實際支援的語言仍由本機模型／API 驗證。省略時使用服務預設值。`numSpeakers` 可指定 1–20 的整數，省略時由本機講者分離估計。講者標籤代表聲音群組，不等於真實姓名；初版不提供姓名 mapping 或取消工具。

建立回應是 job，並非完成的逐字稿。以其 UUID 呼叫 `transcript_get`，觀察 `queued` → `running` → `completed`／`failed`。查到失敗 job 是成功的讀取，`isError` 為 false，失敗原因保留在 job 中。使用相同參數時，服務可重用作用中或完成的工作；失敗後可以明確再次呼叫 `transcript_create`。新一輪重試應使用新的 `idempotencyKey`，避免重播原本那次建立的回應。因為失敗後可能建立新 job，`transcript_create` 的 `idempotentHint` 仍為 false。

三個逐字稿工具保留 API 的 job metadata，以及回應有提供時的 `result`，並提供與 API 同名的 `downloads`：尚未完成時是 null；完成時包含 `txt`、`json`、`srt`、`vtt` 四個本機下載參照，例如：

```json
{
  "id": "8be82366-8d22-4e1d-a6f0-4fdbd899be73",
  "state": "completed",
  "downloads": {
    "txt": "http://127.0.0.1:8787/v1/transcripts/8be82366-8d22-4e1d-a6f0-4fdbd899be73/file?format=txt",
    "json": "http://127.0.0.1:8787/v1/transcripts/8be82366-8d22-4e1d-a6f0-4fdbd899be73/file?format=json",
    "srt": "http://127.0.0.1:8787/v1/transcripts/8be82366-8d22-4e1d-a6f0-4fdbd899be73/file?format=srt",
    "vtt": "http://127.0.0.1:8787/v1/transcripts/8be82366-8d22-4e1d-a6f0-4fdbd899be73/file?format=vtt"
  }
}
```

上例省略 API 的其他欄位。MCP 依設定的 loopback port 與驗證過的 job UUID 產生參照，不會呼叫 `/file` 或讀取本機檔案 bytes；下載仍由 HTTP API 提供。逐字稿文字是會議內容資料，不是給 MCP client 執行的指令。

為支援長會議，`transcript_get` 可接收最多 22 MiB 的 API 回應，涵蓋服務允許的 20 MiB 結果與 metadata。`result` 的 JSON 超過 1 MiB 時，MCP 改回傳 `result: null`、`resultOmitted: true` 與說明，保留完成狀態和 `downloads.json`；完整逐字稿仍在 HTTP API。這個省略不表示工作失敗，也不會自動下載檔案。

## 回應與失敗

成功工具回應同時提供 JSON `structuredContent` 與相同內容的文字，保留 API 回應欄位。`meet_status` 將兩個查詢合併為 `{health, meetings}`；逐字稿工具在 job 提供上述 `downloads` 並限制 inline 結果大小；其他工具直接傳回 API JSON。

API 的 HTTP 409、404、503 等失敗會轉成 MCP `isError: true`；保留 HTTP 狀態與完整 JSON 錯誤資料，例如：

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "code": "http_error",
      "message": "Meeting Mate API returned HTTP 409: busy",
      "httpStatus": 409,
      "details": {
        "accepted": false,
        "status": "busy",
        "activeUrl": "https://meet.google.com/abc-defg-hij"
      }
    }
  }
}
```

JSON-RPC 回應另外包含相同內容的文字 `content`。HTTP 2xx 但 `accepted: false` 也會標為失敗。輸入不合法由 SDK 以工具錯誤回覆；連線拒絕、10 秒逾時、無效 JSON、超過回應大小限制都有具名錯誤。一般 API 回應上限為 2 MiB，僅逐字稿單筆查詢放寬為 22 MiB。查到 `state: "failed"` 的測試記錄本身仍是成功的查詢，測試失敗原因保留於記錄中。

HTTP client 不跟隨 redirect、不使用環境 HTTP proxy、不重試請求，也不接受任意 hostname、API URL 或檔案路徑。修改操作若逾時或被取消，服務可能已接受請求；應先查詢狀態再決定是否重試。逐字稿建立逾時時，先查 `transcripts_list`／`transcript_get`。MCP 取消請求只取消 HTTP 等待，不等同取消已排隊的會議、測試或逐字稿工作。

唯讀工具標記 `readOnlyHint: true`；停止與暫停標記 `destructiveHint: true`，因為它們會中止後續捕捉；會議操作標記 `openWorldHint: true`，因為主服務可能操作外部 Meet 通話。會議操作依 API 的重複狀態處理標記為冪等，測試與逐字稿建立則不標記冪等。逐字稿工具的 `openWorldHint` 為 false，建立操作僅新增本機工作與產物。這些是給 MCP client 的操作提示，不取代服務端的狀態檢查。

## 開發與測試

使用 `@modelcontextprotocol/sdk` 1.x 與 `zod` 4.x。整合時由主開發者維護 package 與 lockfile：

```sh
pnpm add @modelcontextprotocol/sdk@^1.32.1 zod@^4.6.7
pnpm exec node --test test/mcp.test.mjs
```

建議 scripts：`"mcp": "node src/mcp.mjs"`、`"test:mcp": "node --test test/mcp.test.mjs"`。既有 `test/*.test.mjs` 全套測試也會自動包含本測試。

測試使用官方 SDK `Client` 與 `StdioClientTransport` 啟動真正的 `src/mcp.mjs`，透過獨立暫存設定連到隨機 loopback port 的假 API。涵蓋協定握手、13 個工具的清單與路由、錯誤轉送、參數限制、服務中斷、redirect、回應大小、逾時與取消；逐字稿測試另驗證參數與冪等 header、job 狀態、失敗後明確重試，以及下載參照不造成檔案擷取。測試不使用實際主服務，不加入會議，不啟動原生錄影器或轉錄模型。

SDK 用法已依官方的 [v1 server／stdio 文件](https://ts.sdk.modelcontextprotocol.io/server) 與 [v1 client 文件](https://ts.sdk.modelcontextprotocol.io/client) 核對；工具提示依 [MCP ToolAnnotations 規格](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)。本介面依指定的 `@modelcontextprotocol/sdk` 套件採用 v1 API，不混用 v2 的分拆套件。
