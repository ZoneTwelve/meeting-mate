# 本機 API

服務預設位址為 `http://127.0.0.1:8787`，機器可讀契約為 `GET /v1/openapi.json`。已有服務時直接呼叫；首次啟動見 [README](../README.md)，不要為了試 API 而重啟正在錄影的服務。

## 信任與安全邊界

API 只綁 `127.0.0.1`，供**可信任的同機程式**與 MCP 使用。**沒有 bearer token、使用者登入或細分權限驗證**；同機程序可讀錄影／逐字稿及操作會議。Host allowlist 為 `127.0.0.1`、`localhost`、`[::1]`（可帶 port），帶 Origin 的請求會被拒絕；這些檢查不是身分授權。請勿透過 port forwarding、反向代理或公開 port 暴露服務。Token defense 是後續待辦，並非已提供的功能。

所有 POST 要求 `Content-Type: application/json`，body 上限 2 KiB，只接受各路由列出的欄位。舊 `/join` 與 `/healthz` 同樣經過邊界檢查。回應可能含私人會議 URL、本機路徑或文字，不能直接貼進 public repo、公開 issue 或 log。

## 端點

| 方法與路徑 | 輸入／用途 |
| --- | --- |
| `GET /healthz` | 服務、會議、影音測試狀態及 `transcription` 佇列摘要 |
| `GET /v1/openapi.json` | OpenAPI 3.1 |
| `GET /v1/meetings` | `{meetings: [...]}`，包括排程及手動會議 |
| `POST /v1/meetings/join` | `{ "url": "https://meet.google.com/abc-defg-hij" }`；立即要求加入；`POST /join` 為相容入口 |
| `POST /v1/meetings/stop` | `{ "url": "…" }`；收尾並退出，省略 url 操作目前會議 |
| `POST /v1/meetings/pause` | `{ "url": "…" }` 或 `{}`；完成當段、留在通話 |
| `POST /v1/meetings/resume` | `{ "url": "…" }` 或 `{}`；同 session 新開片段 |
| `GET /v1/recordings?limit=50` | `{recordings: [...]}`，最新優先，limit 整數 1–100 |
| `GET /v1/recordings/:id` | 錄影 metadata、時長／codec、session 與下載位址 |
| `GET /v1/recordings/:id/file` | verified MP4，支援單一 HTTP Range |
| `GET /v1/diagnostics` | recorder 權限、Chrome、FFmpeg／ffprobe、磁碟等檢查；快取 30 秒 |
| `POST /v1/recording-tests` | `{}`；非同步原生合成影音測試 |
| `GET /v1/recording-tests/:id` | 影音測試狀態；id 可用 `latest` |
| `POST /v1/transcripts` | `{recordingId, language?, numSpeakers?}`；建立／沿用本機逐字稿工作 |
| `GET /v1/transcripts?limit=50` | `{transcripts: [...]}`，最新工作優先，limit 整數 1–100 |
| `GET /v1/transcripts/:id` | UUID 工作 metadata，完成後含 `result`，其餘為 null |
| `GET /v1/transcripts/:id/file?format=txt` | completed 工作匯出；format 為 `json`／`txt`／`srt`／`vtt`，預設 txt |

沒有 transcript 取消、刪除或姓名 mapping 端點。只有 recording-test ID 支援 `latest`；transcript 必須使用列表或建立回傳的 UUID。

## 立即加入、暫停與停止

以下 Meet URL 是虛構範例，實際使用時換成自己的連結，勿提交到 Git：

```sh
curl http://127.0.0.1:8787/v1/meetings/join \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-meeting-001' \
  --data '{"url":"https://meet.google.com/abc-defg-hij"}'

curl http://127.0.0.1:8787/v1/meetings/pause -H 'Content-Type: application/json' --data '{}'
curl http://127.0.0.1:8787/v1/meetings/resume -H 'Content-Type: application/json' --data '{}'
curl http://127.0.0.1:8787/v1/meetings/stop -H 'Content-Type: application/json' --data '{}'
curl http://127.0.0.1:8787/healthz
```

`202` 表示控制意圖已受理，實際動作由單一會議迴圈執行；回應例如 `accepted: true, status: "queued"`、`pause_queued`、`stop_queued`。請查 `/healthz` 或 `/v1/meetings` 確認完成。`waiting_approval` 仍是候場；通過且原生 recorder started 後才是 `recording`，不能把加入請求視為已錄影。

`paused` 會保留通話與資源鎖，不因暫停自動離會，也不觸發整場轉錄；仍適用已知單人持續 30 秒退出與最長通話限制。resume 使用同 session 新段，不再要求主持人放行。manual stop 成功為 `stopped`，設定檔 URL 至少延後一個檢查週期再嘗試；臨時連結是 one-shot。真正離場與收尾可能有 tick／驗證延遲。

錄影以 `sessionId`、`segmentIndex` 關聯；舊錄影兩欄可能為 null。metadata 狀態目前有 `starting`／`recording`／`verified`／`failed`，**沒有獨立 finalizing 狀態**，必須等 verified 才下載。verified 表示正常收尾且 ffprobe 讀到有效影音，不代表每一刻有聲、沒有漏錄或文字一定可辨識。來源只能用受控 recording ID，不接受路徑／URL／symlink 作任意讀檔。

## 錄影後自動逐字稿

`transcriptEnabled` 預設 true。session 結束並收尾、關閉 Meet 頁面後，服務自動將逐字稿排入本機佇列；單純換段或 pause 不會提交。請在結束後查 `/v1/transcripts`，不必再手動 POST。模型需要先在本機備妥：

```sh
# 首次安裝需要網路下載環境與模型，不上傳會議音訊
pnpm run transcript:setup

# 只檢查本機必要檔案，不安裝；不是模型品質測試
pnpm run transcript:setup --check

curl 'http://127.0.0.1:8787/v1/transcripts?limit=10'
```

目前 setup 限 macOS arm64，使用本機 Python 3.12、faster-whisper small CPU int8、sherpa-onnx 分群。執行轉錄時只讀本機模型，設定離線模式並阻擋 Python 網路連線；缺模型會讓工作 failed，不默默下載或改送雲端。這不是 OS 級網路 sandbox。`/v1/diagnostics` 只涵蓋錄影環境，不驗證語音模型。

選定一個 recording ID 時：有 `sessionId` 就納入同場全部已索引片段；沒有則只處理該舊檔。場次必須已結束，片段全部存在且 verified、時長有效，否則 409；不會偷偷跳過已知 failed 段。沒有可用錄影時不建立自動工作。自動排入失敗（例如佇列滿、片段驗證失敗）會記錄錯誤，不阻擋錄影器清理；目前沒有自動補投。

手動轉錄既有錄影或重試失敗工作：

```sh
# 先取受控 ID；以下 sample-recording.mp4 僅為佔位名稱
curl 'http://127.0.0.1:8787/v1/recordings?limit=10'

curl http://127.0.0.1:8787/v1/transcripts \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: transcript-example-001' \
  --data '{"recordingId":"sample-recording.mp4","language":"zh","numSpeakers":2}'
```

| 參數 | 契約 |
| --- | --- |
| `recordingId` | 必填，錄影清單中的 ID；不能是檔案路徑或 URL |
| `language` | 選填，預設 config 的 transcriptLanguage（預設 auto）；API 接受 auto 或小寫 2–3 字母語言碼，例如 zh／en。格式合法不保證模型支援，未支援會使 worker 失敗 |
| `numSpeakers` | 選填整數 1–20；省略由模型自動分群。現階段自動分群有過度分群，已知人數建議提供；指定人數不是姓名或身份確認，也不保證逐句分配正確 |

POST 回 `202` 與工作 metadata（不是會議控制的 accepted/status 物件）。相同來源 metadata、language、numSpeakers、engineVersion 的 queued／running／completed 工作可以沿用，所以 202 回傳的 state 不一定是 queued。failed 重新提交會建立新 UUID；重試需使用新 Idempotency-Key 或不帶 key，避免重播原始受理回應。fingerprint 不是整份音訊內容 hash。設定 `transcriptEnabled: false` 只關閉自動提交，仍可手動 POST。

### 查詢結果與下載

將以下虛構 UUID 換成建立／列表回傳的 id：

```sh
curl http://127.0.0.1:8787/v1/transcripts/00000000-0000-4000-8000-000000000001
curl 'http://127.0.0.1:8787/v1/transcripts/00000000-0000-4000-8000-000000000001/file?format=txt'
curl 'http://127.0.0.1:8787/v1/transcripts/00000000-0000-4000-8000-000000000001/file?format=json'
curl 'http://127.0.0.1:8787/v1/transcripts/00000000-0000-4000-8000-000000000001/file?format=srt'
curl 'http://127.0.0.1:8787/v1/transcripts/00000000-0000-4000-8000-000000000001/file?format=vtt'
```

狀態為 `queued → running → completed／failed`。檢查 `phase`、`suspended`、`attempts`、`error` 與 timestamps；phase 可能為 extracting、diarizing、transcribing、exporting。progress 是 worker 的階段訊號，不保證整場百分比或 ETA。未完成時 `result: null`，下載回 409；failed 工作的 GET 仍可回 200，錯誤在工作本身。

完成後 result 包含 `jobId`、`language`、`duration`、`speakers`、`segments`、`engine`、`warnings`。每段文字含 `start`／`end`（秒）、`speakerId`、`text`、`recordingId`；Speaker ID 如 `speaker_1`，顯示名稱如 `Speaker 1`。四種匯出都有可辨識的 Speaker 標籤；TXT／SRT／VTT 是 UTF-8，JSON 保留結構與模型資訊。

同場音訊做一次全場 diarization，跨片段共用分群；ASR 以分窗方式處理。輸出時間從第一段開始，依片段實際 startedAt offset 映射，保留 pause／換段間隙；字幕不能直接套在每一段從零開始的 MP4，也不會生成合併影片。`Speaker 1` **不等於真人姓名**，跨會議也不代表同一人。重疊詞只選最相符的聲音，沒有可靠對齊的詞可能省略並附 warning；無可理解語音可產生空稿。Diarization 目前為**實驗性**：本機實測 70 秒樣本自動分出 5 組（含約 0.26 秒短組），486.9 秒樣本分出 21 組，出現嚴重過度分群。四格式功能已驗證，但分群品質未通過；已知人數時建議提供 numSpeakers，仍須人工校對。指定 2 人的短樣本重跑進行中，不承諾尚未量測的準確率。

### 佇列與資源限制

- 最多 20 筆 queued、一次一個 worker；滿佇列回 409。工作按排隊順序處理。
- 會議、候場、pending join、pause／收尾或合成影音測試活動時，延後 worker 啟動；已啟動的自有 process group 會在處理迴圈觀測後 SIGSTOP，閒置時 SIGCONT。它不會退出會議，SIGSTOP 也不釋放記憶體。
- worker 從啟動算四小時牆鐘期限，包含暫停時間；逾時 failed。沒有硬 RAM 配額或處理速度承諾。
- worker 一次最多 1000 段、合計 12 小時錄製音訊；JSON 輸出上限 16MiB，服務讀取驗證另設 20MiB 上限；超限是失敗，不改用遠端。
- 來源在執行前會再檢查路徑／大小／mtime；變更須重新提交。原 MP4 不會覆寫。
- graceful shutdown 中斷的工作回 queued，重啟恢復 running 工作也會重排；completed／failed 歷史保留。目前沒有自動清理／取消端點。

`/healthz.transcription` 提供 enabled、activeJobId、queued；頂層 state 仍表示會議／錄影測試，`scheduled` 不代表沒有轉錄工作。逐字稿、input manifest、暫存音訊和 logs 都是私人資料，必須留在 Git 忽略的本機資料夾。

## 非同步錄影測試

```sh
curl http://127.0.0.1:8787/v1/recording-tests -H 'Content-Type: application/json' --data '{}'
curl http://127.0.0.1:8787/v1/recording-tests/latest

# 用正式 SDK 驗證 MCP → API → 原生測試鏈路
pnpm run test:live
```

受理即保留錄影資源，回 202、UUID 與 `state: running`；沒有另設 queued state。背景播放低音量測試音、錄約 10 秒動畫，驗證可解碼影音、maxVolumeDB ≥ −60、distinctFrames ≥ 2。終態為 `passed`／`failed`／`timed_out`／`cancelled`，整體期限預設 90 秒，最新 20 筆 job metadata 留在本機；cancelled 可由服務 shutdown 產生，沒有取消 API。

僅在沒有會議活動時啟動，執行中略過排程並拒絕加入，避免測試音混入正式會議。直接 `pnpm run test:av` 未取得服務共鎖，不能與可能自動加入的服務並行。此測試不驗證主持人放行、真實遠端聲音或逐字稿品質。最近一次 L2 成功證據與未測項目見 [測試紀錄](test-plan.md)。

## HTTP 回應與重試

`200` 為讀取成功或控制已在要求狀態；`202` 為非同步受理／沿用工作；`400` 無效輸入；`403` 非允許本機請求；`404` 不存在；`409` 忙碌、狀態衝突、未完成、佇列滿或 key 衝突；`413` body 太大；`415` 非 JSON；`416` 錄影 Range 錯誤；`422` 無效／過大的已讀 metadata／結果；`503` 服務停止或未就緒；其他未處理錯誤為 `500`。目前沒有 auth 401 流程。

例外回 `{ "error": "說明" }`，控制拒絕則可能為 `{accepted: false, status, ...}`；尚無統一 machine error code／retryable 欄位。影音測試與轉錄的後續失敗保存在 job，不能把最初的 202 當成功。diagnostics 回 200 時仍要檢查總體與逐項 `ok`。

所有 POST 可帶 `Idempotency-Key`（最長 128 字元）。同 key、同路徑與序列化 body 共用原始回應；同 key 不同請求回 409。最多 200 筆、最長一小時、僅該服務進程內保留，重啟失效；不是跨重啟 exactly-once。重播是原始 receipt，不會刷新 job 狀態，需另 GET。未收到回應時先查狀態，不要盲目重送新 key；開始新一次操作時應使用新 key。
