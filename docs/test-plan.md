# Meeting Mate 測試計畫與紀錄

## 本輪範圍與證據

本輪包含 API、MCP、錄影測試與**自動本機逐字稿／Speaker 分群**。姓名 mapping 未實作，公開 repo 發布另經隱私稽核。能力與風險 ID 見 [requirements.md](requirements.md)，未完成項目見 [Todo.md](../Todo.md)。

### 已收到的整合驗證結果

以下是整合者回報的證據；本次文件整合沒有重跑 native、操作會議、重啟服務或重簽 App。中途測試結果不自動涵蓋後續改動。

| 層級／時間 | 命令或方式 | 結果與範圍 |
| --- | --- | --- |
| L1，最新整合回報（2026-10-23） | `pnpm test` | 128 passed；Node 單元／mock 整合，不能代替真模型／Meet 品質測試。 |
| T1，最新整合回報 | Python 轉錄邏輯測試 | 27 passed，獨立於上述 Node 數量。 |
| 語法，最新整合回報 | `pnpm run check` | 通過；不代表 native 或模型品質成功。 |
| L2，2026-10-23 00:00:50 Asia/Taipei（2026-10-22T16:00:50Z） | `pnpm run test:live`，官方 SDK → MCP → API → 原生 recorder | 通過；列出 13 tools；測試 job `debca928-5f1e-4a67-9f70-7ed91e72a4f9` 為 passed。該次服務回報 apiVersion 1，完成後閒置。 |
| T2，真模型逐字稿 | 本機 ASR／diarization 與四格式匯出 | JSON／TXT／SRT／VTT 功能已驗證；自動分群有嚴重過度分群，品質未通過，詳見下方紀錄。 |
| L3，真實多人 Meet | 主持人核准＋遠端發言＋全員離場 | **本輪未執行**；舊輪次的 Meet 成品不能代替這輪 E2E。 |
| 公開 repo | `ZoneTwelve/meeting-mate` public origin 與 push | 使用者回報 repo 已建立並提供 SSH 驗證環境；整合者仍須驗證可見性、origin 及 push，尚無本文件可記錄的推送結果。 |

L2 實測指標：10.061667 秒、422655 bytes、H.264／AAC、150 個 video frames、469 個 audio frames、maxVolumeDB −31.7、distinctFrames 20。私人證據位於 `.meeting-mate/mcp-live-report.json` 與 `.meeting-mate/smoke/report.json`；它們可能含本機路徑／私人 metadata，**不加入公開 repo**。公開文件只保留上述去識別指標。

### 測試層級

| 層級 | 真實元件與命令 | 不能證明的事情 |
| --- | --- | --- |
| L1 單元／mock 整合 | `pnpm test`、`pnpm run test:mcp`；Node、暫存目錄、假 browser／recorder／API、SDK stdio 子程序 | Meet UI、主持人收到請求、原生權限、實際影音或模型品質 |
| T1 轉錄邏輯 | `pnpm run test:transcript`；Python 純邏輯＋Node 假 worker／暫存來源 | 模型真的能辨識多人／繁中、實際 CPU／記憶體需求 |
| L2 原生合成 A/V | 優先 `pnpm run test:live`／API job；真 Chrome、已授權 App、ScreenCaptureKit、FFmpeg、動畫／合成音 | Google 登入／主持人核准、遠端聲音、實際人數與長時可靠性 |
| T2 真模型轉錄 | 本機安裝模型，用明確非敏感的合成多人語音與分段 MP4 驗證 | 真實混音會議的通用準確率、真人姓名、所有語言／硬體 |
| L3 真實 Meet | 主持人、另一位參與者及 bot；從加入至錄影、退出、自動轉錄 | 其他會議政策／UI 語系／平台／長時情境 |

L1／T1 不讀個人 Chrome profile、不啟 native、不碰正式錄影。L2／T2／L3 不得停止正式會議來讓測試通過；候場、pause、收尾、pending join 都是忙碌。health 只是快照，啟動仍須後端取得共鎖。合成聲音不是可轉錄語句，L2 passed 不能冒充 T2 passed。

## L1／T1：目前測試來源與待補

| 檔案 | 已有程式案例範圍 | 尚需擴充／另行驗證 |
| --- | --- | --- |
| `test/config.test.mjs` | 訪客名稱、路徑、Meet URL、設定／LaunchAgent XML | 轉錄設定邊界與更多無效語言；不測不存在的 token 配置 |
| `test/meet-page.test.mjs` | 訪客欄、候場／登入、People badge、指定及延遲 popup | 隱藏／矛盾人數、聊天 only-one 引用、多語 fixtures |
| `test/monitor.test.mjs` | 核准前不錄、互斥、權限重試、空房／分段、手動 join、stop／pause／resume 與部分 await 競態 | 完整交錯矩陣、session 完成 hook 端到端、paused 時全員離場 |
| `test/recorder.test.mjs` | 假 native started／error／finished、啟動期限、stop 去重 | 慢 ffprobe、段中磁碟滿、crash／metadata 恢復；仍非 native 實測 |
| `test/control-server.test.mjs` | 版本路由、Host／Origin／JSON、busy、冪等、非同步 transcript／匯出 | 更多 body／串流邊界、長工作期間狀態查詢 |
| `test/recordings.test.mjs` | 索引／排序、路徑與 symlink、verified gate、Range 206／416 | client abort／慢 client、來源被替換等 race |
| `test/recording-tests.test.mjs` | 同步占鎖、期限／shutdown、過期或無效 report、exit/error、歷史與有界 logs | 真 Chrome／native 故障只在隔離環境注入 |
| `test/mcp.test.mjs` | 真 SDK stdio 接假 API，13 tools、schema／錯誤／timeout／冪等；transcript 回參照及大型結果限制 | 真服務鏈路見 L2；不因 mock 回 transcript 就宣稱模型通過 |
| `test/transcripts.test.mjs` | 全 session offsets、去重、拒活動／未完成來源、假 worker、匯出、SIGSTOP／SIGCONT、失敗／重啟 | queue 20、四小時 timeout、低空間／來源變更、完整 auto hook 的整合案例 |
| `test/transcribe_test.py` | manifest、時間軸／接縫、跨段 Speaker、重疊配詞、空語音、Unicode、網路 audit | 真模型品質與 OS 層離線驗證不由這些純邏輯測試涵蓋 |
| `test/cdp.test.mjs` | 假 WebSocket 正常／錯誤／斷線／timeout／清理 | 真 Chrome crash 不可由 fake 代替 |
| `test/idle.test.mjs`、`test/schedule.test.mjs` | 閒置判斷、graceful restart 排程 | paused／finalizing／test／pending join 的完整升級保護 |

下列是驗收清單，**不是逐項已通過的結果表**。來源中存在案例不等於該情境已實測；待補案例需由實作方逐項執行或保留為未測。

### 控制狀態機

| ID | 情境 | 驗收條件 |
| --- | --- | --- |
| U01–U02 | 有效／惡意 Meet URL、訪客名稱／帳號／needs_login | 無效輸入不開頁；訪客名稱確認後才加入；不假稱設定名稱等於 Google 登入 |
| U03–U04 | 等待核准、重送、同／不同 URL 並發、prepare await 中新請求 | 一次敲門，核准前無 recorder；不同活動會議 busy；owner 不被取代 |
| U05–U06 | one-shot／recurring，native started 延遲／失敗 | 前者不再週期重入；後者保留排程；started 前不宣稱錄影，失敗不立即退出獲准通話 |
| U07 | queued／prepare／joinInFlight／starting／recording／paused／收尾時 stop | 無新 recorder 復活；先收尾再離會；重複 stop 無第二次副作用 |
| U08–U10 | pause、重送、resume、pause 收尾時 stop／resume 交錯 | 保留通話、只開一段、無再次核准；stop 最終終止；不把 pause 當閒置 |
| U11 | count=1 到 29／30 秒、回到 2、未知 count、paused | 連續滿門檻才結束；回升重置；unknown 不直接視為 alone |
| U12–U13 | ended、prejoin 斷線、loading、max session、無虛擬相機、late popup | 有 reason 且不無限錄；不開實體相機、麥克風關閉；只關指定提示 |

### REST、檔案與非同步測試

| ID | 情境 | 驗收條件 |
| --- | --- | --- |
| H01 | 無 token 的可信同機 client；health／舊路由／v1 | 依現況可存取；文件明說沒有身分授權，不虛構 401/token 行為。token 測試留待實作 |
| H02–H03 | 非允許 Host、Origin、非 JSON、未知欄位、損壞／超 2KiB body、未知路由 | 403／400／413／415／404 與現有 `{error}` 契約一致；拒絕時無業務副作用 |
| H04–H06 | 同 key 同／不同 payload、並發、慢 start／stop／ffprobe | 同 key 共用回應、衝突 409；202 後查 state；timeout 不自動重試，無跨重啟 exactly-once 承諾 |
| H07–H09 | verified／starting／recording／failed、壞 sidecar、缺檔、穿越／symlink、Range／abort | 不把殘檔當 ready；只讀受控 regular file；206／416 正確、handle 釋放；目前無獨立 finalizing state |
| H10 | smoke 受理未 spawn，與定時／API／MCP join、第二 smoke 競爭 | 第一請求同步占鎖，其他 busy；候場／pause／收尾不放行；不需對真會議發請求來測競態 |
| H11–H12 | 有效／舊／缺失 report、非零 exit、native 卡住、靜音／靜止、shutdown | running 只有當次影音驗證全過才 passed；其餘 failed／timed_out／cancelled；90 秒期限、只清自己的 child；保留最新 20 jobs |
| H13 | diagnostics 缺依賴／權限／空間、逾時 | 逐項 ok/detail、有 checkedAt／快取；不彈授權、不重簽、不開會議；不代表模型已備妥 |

### MCP stdio

| ID | 情境 | 驗收條件 |
| --- | --- | --- |
| M01–M02 | initialize／tools list／13 tools／錯參數 | stdout 符合協定；正確映射 REST；錯誤輸入不發 HTTP、不接受任意 shell／路徑 |
| M03–M04 | API 409／503／非 JSON／timeout／redirect／非法 port | 保留可判斷錯誤，只連固定 loopback，不跟 redirect，不自動重試 mutation；目前不轉送不存在的 token |
| M05 | 並發、EOF、test／transcript running 時 client 離線 | 後端持有互斥與工作；stdio 結束不停止錄影服務／背景工作 |
| M06 | 影片／逐字稿 metadata、巨大 transcript、文字含指令 | 只回受控下載參照，完整 transcript 超 1MiB 不 inline；內容當資料；failed job 可成功查詢但不能稱工作完成 |

### T1：逐字稿管理與時間軸

| ID | 情境 | 驗收條件 |
| --- | --- | --- |
| T01 | session 完成、pause／rollover、無錄影、failed 片段、auto 關閉 | 只在完整結束後自動提交；有可用來源且全數 verified；失敗不阻擋關頁；關閉 auto 不禁止手動 POST |
| T02 | 選同場不同片段、舊版無 session、活動場次、任意路徑 | 同 session 包含全部已索引片段；legacy 僅單檔；活動／未完成 409；不接受任意輸入檔 |
| T03 | 同 fingerprint 重送、failed 重試、不同 language／numSpeakers | 活動／completed 可沿用；failed 新 job；新 HTTP key 避免重播舊 receipt；來源 metadata／engineVersion 去重不冒稱音訊 hash |
| T04 | 20 queued、1 running、四小時期限、模型缺失、低磁碟／來源變更 | 上限與失敗可查，無偷偷下載／上傳；會議照常可運作；部分邊界尚待補測 |
| T05 | 忙碌時排隊、worker 已跑後會議開始、shutdown／重啟 | SIGSTOP／SIGCONT 僅自己的 group；suspended 可查且牆鐘期限繼續；中斷重排，不破壞原片 |
| T06 | 多段、pause gap、接縫詞、重疊、同一 speaker 回來 | 一次全場分群；共同時間軸與 recordingId 可追溯；不重複接縫詞、不誤刪 gap、不宣稱分離每人音軌 |
| T07 | 空語音、無可靠對齊、未知姓名、JSON／TXT／SRT／VTT | 可空結果附 warning；只有 Speaker N、不猜姓名；格式／UTF-8／時間有效；模型準確率另測 |
| T08 | 本機模型與網路 audit、輸出錯 job／錯 speaker／越界時間 | 不通過即 failed；原始音訊不外送；純邏輯網路測試不等於 OS 級隔離證明 |

## L2：原生合成影音

前置：既有授權 App、合成相機、FFmpeg／ffprobe、足夠空間，且無候場／通話／pause／收尾／pending join。不要重建、重簽或清除 TCC。優先 `pnpm run test:live` 或 `/v1/recording-tests`；直接 `pnpm run test:av` 未取得 monitor 鎖，不能與可能自動加入的常駐服務並行。

| ID | 證據 | Gate |
| --- | --- | --- |
| N01–N02 | 當次 job、native 事件、MP4／sidecar、ffprobe | 正常收尾、正時長、影音都有可讀 frames；記錄真實 codec／大小／時長 |
| N03 | FFmpeg volumedetect／framemd5 | maxVolumeDB ≥ −60、distinctFrames ≥ 2；report 的 jobId 與當次一致 |
| N04 | 播放抽查／非敏感 preview | 目標動畫／RECORDING 卡、測試音；自動 metrics 不等於已人工看過／聽過 |
| N05–N06 | busy 與資源回收 | 無第二 recorder／加入副作用；tab／音源／server／child／lock 清理；mock 競態與 live 觀察分開紀錄 |

本次 N01–N03 的指標與 API／MCP 鏈路已有上方 L2 證據；未附人工播放／全部故障注入的結果，不把它們一併打勾。最新 smoke report 會覆寫，需用 job ID 判別，不以檔案存在當成功。

## T2：真模型功能已驗證，分群品質未通過

整合者回報 JSON／TXT／SRT／VTT 均已產生且可讀。70 秒樣本的自動分群輸出 5 組，其中一組僅約 0.26 秒；486.9 秒樣本輸出 21 組，顯示嚴重過度分群。使用者認為短樣本是 2 人，但尚未建立人工逐句正解，不能據此宣稱量化準確率。指定 `numSpeakers: 2` 的重跑已完成，但第二組仍只有約 0.26 秒，未通過聲音歸屬驗證。隔離比較 NeMo embedding 也沒有證實改善，預設模型未切換。合成雙聲音可自動分出 2 群，不代表真實會議準確率；詳細證據與來源音軌限制見 [transcript.md](transcript.md)。

目前 diarization 應標為**實驗性**；已知真實人數時建議提供 numSpeakers，並人工校對。限制群數也不能證明每句分配正確，不能以四種檔案存在或固定 2 人後輸出 2 組當作 speaker accuracy gate。

先用非敏感、人工可核對的兩種合成聲音，安排 A → B → A，跨兩個錄影片段並加入已知 gap；另做靜音／單人樣本。使用已驗證來源與本機 setup，不下載或提交真實會議內容作公開 fixture。

需保留：模型／套件版本、觸發方式、工作 phase／終態、耗時、來源與輸出時間對照、Speaker 數／回返一致性、四種匯出是否可讀、warnings，以及無外部轉錄的證據。全自動 speaker count 與指定 `numSpeakers` 是不同情境；不能只固定 2 人後宣稱自動人數偵測已通過。

T2 可以證明特定樣本真的跑過 ASR／diarization，不能證明真實繁中／中英混用或重疊會議準確率。後續人工正解集要分別量測文字錯誤、speaker 分群錯誤、時間偏移；姓名 mapping 等待功能實作後才測。

## L3：真實 Meet（本輪未執行）

由主持人 H、參與者 P 與 bot 進行受控會議，事先知悉錄影；使用非敏感短句、讀秒與分享動態畫面。公開紀錄僅使用範例網址 `https://meet.google.com/abc-defg-hij`，真實連結與成品留本機。

| ID | 步驟 | 通過條件 |
| --- | --- | --- |
| E01 | H 暫不核准 | 持續看見單一加入請求，不閃退；waiting_approval 且未錄影 |
| E02–E03 | 核准、P 發言／分享，等待 self-view 提示 | in_call 後 native started；看見 RECORDING 卡、麥克風關閉；錄到 P；只關指定 popup |
| E04 | pause 說標記句、resume 再說一句 | pause 留在場但不錄，resume 新段且無新核准請求；同 session |
| E05–E06 | 人員逐一離場、alone 20 秒後返回再離開 | 有他人不結束；回返重置；最後只剩 bot 約 30 秒＋觀測／收尾延遲退出，MP4 verified |
| E07 | 候場 stop、錄影 stop、重送 | 撤回請求／先收尾再關頁，無重入；recurring 排程效果符合契約 |
| E08–E09 | 拒絕／移除／結束、短暫斷線／loading | 記錄現有策略與 reason，不假定已有自動重連；既有成品保留 |
| E10–E11 | 多段、其他 Chrome 音源、特殊 People count | 量測間隙、混音、人數語意；不承諾無縫／完全隔離 |
| E12 | 自動結束後查 transcript | 自動產生可查 job，完成後時間與文字／Speaker 可人工對照；只用 Speaker N，不猜參與者姓名 |

至少記錄：H 看見／核准時間、native started／finished、指示可見、最後他人離場、aloneSince、關頁、檔案驗證與 transcript 工作終態。30 秒不是端到端硬 deadline；API 202 不是會議成功證據。

## P1 故障與發布 gate

隔離環境再測慢 ffprobe 超過 30 秒、段中磁碟下降、損壞 sidecar、native exit 0 卻無 finished、parent crash、分段後立即 stop、長轉錄被頻繁暫停。不可對正式錄影程序注入 SIGKILL。紀錄 failed／unknown 與可恢復範圍，不要求斷電也有完整 MP4。

最終執行相關 `pnpm` tests 與 `pnpm run check`，記錄 run 時間／版本、pass／fail／blocked／not_run、私人產物位置及去識別指標。未測層級保持未測。Repo watcher 的測試由其負責者提供；只有完成特定功能、檢查現有變更、審核選定 staged diff 沒有秘密／實際會議資料，再核對授權 public origin，才可 commit／push。SSH／GitHub 授權、測試、origin 或隱私檢查阻擋時留在本機，不宣稱已發布。
