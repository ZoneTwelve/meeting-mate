# Meeting Mate 需求與能力矩陣

## 範圍與狀態

本輪包含版本化本機 REST API、MCP stdio、非同步錄影測試，**以及錄影結束後自動產生本機逐字稿與 Speaker 分群**。真人姓名對應、雲端轉錄及公網服務不在本輪。使用 `pnpm`、專用一般 Chrome／CDP、macOS ScreenCaptureKit；不新增 Playwright。

以下「基線」指本輪前的錄影功能；「本輪程式」描述目前來源碼，不保證已部署或所有情境已實測；「後續」仍未完成。P0 是核心交付，P1 是可靠性／品質，P2 是擴充。實際端點見 [API](api.md)，工具見 [MCP](mcp.md)，驗收證據見 [測試計畫](test-plan.md)，未完成事項見 [Todo](../Todo.md)。

目前驗證：整合者已驗證 Node 142 tests passed、Python 27 passed；2026-10-23 00:00:50 Asia/Taipei 的 SDK → MCP → API → 原生合成錄影通過。真模型已產生四種格式，**功能通過不等於分群品質通過**：70 秒自動分 5 組（含約 0.26 秒短組），486.9 秒自動分 21 組，出現嚴重過度分群。短樣本被認為有 2 人但尚非人工正解，指定 2 人的重跑已完成，第二組仍只有約 0.26 秒，未通過品質驗證。合成雙聲音可自動分出 2 群；NeMo embedding 對真實錄影的比較未證實修正。Diarization 暫列實驗性，提供 numSpeakers 也不能免除人工校對。**本輪沒有主持人＋多人真實 Meet E2E**。

## 能力矩陣

### 加入、身分與生命週期

| ID／優先 | 能力 | 基線 | 本輪程式 | 後續／限制 |
| --- | --- | --- | --- | --- |
| J01／P0 | URL 立即加入 | `join:now` → `/join`；Meet HTTPS／host／會議碼驗證 | v1 REST、舊路由及 MCP 共用驗證、排程與互斥；受理回 queued | 202 不等於入會；不可送任意網址；其他平台另案 |
| J02／P0 | 訪客名稱 | `.env` 的 `MEET_USERNAME`，1–60 字元；填寫並確認訪客欄位 | 保留既有行為，API 暴露設定名稱與會議觀測狀態 | 不是 Google 登入憑證；metadata 的設定名稱不保證等於帳號顯示名稱 |
| J03／P0 | 帳號登入 | 使用專用 Chrome 的既有登入；needs_login 保留頁面供人工處理 | 不接收密碼、不繞過 Google 或主持人核准 | 多帳號／profile 隔離與 Workspace 政策另驗證 |
| J04／P0 | 主持人核准 | 請求一次，預設等 15 分鐘；拒絕／移除／結束概括為 ended | stop 可撤銷候場；核准前不錄影；busy／needs_login／timeout 可查 | 更細終止原因與人工允許重入；本輪主持人端未重測 |
| J05／P0 | 週期／一次性 | 設定內 URL 依上次嘗試每小時檢查；額外 URL 為 one-shot | 狀態有 oneShot／nextCheckAt；manual stop 延後下一次檢查，不刪排程 | 日期／時區／工作日、排程 CRUD、日曆不在本輪 |
| J06／P0 | 單場互斥 | owner、pending join、in-flight guard | tick／會議控制序列化；API 影音測試與會議活動共鎖；pause／候場不視為閒置 | 直接 `test:av` CLI 不取得服務鎖；多場錄影需獨立音源與資源 |
| J07／P0 | 自動錄影 | in_call 且非已知空房才開始；權限錯誤保留通話 | 延續 native started 後才開 RECORDING 卡的門檻 | 「只加入不錄」需另設選項；不保證所有 Meet 政策允許加入 |
| J08／P0 | stop | 原有 shutdown／會議結束收尾 | 取消 queued join、撤銷候場或先收尾再離會；stop 意圖在 await 後重查 | stop 是當次 session，不是刪除 recurring schedule；受理與完成須分辨 |
| J09／P0 | pause／resume | 原先沒有控制介面 | pause 完成當段、關相機並保留通話；resume 同 session 新片段，不再敲門 | 非無縫單一 MP4，也不會停止 Meet 音訊接收 |
| J10／P0 | 空房結束 | 已知只剩自己持續 30 秒後退出；剛入空房不錄 | pause 仍受空房與最長通話規則約束；有其他人時重置 alone 計時 | 人數來源可能誤判；30 秒是 debounce，不含 tick／收尾延遲 |
| J11／P1 | 斷線／重入 | 回 prejoin 結束；loading 先停錄；暫時 UI／錄影錯誤重試 | 保留既有保守策略，不因 API timeout 自動再送加入請求 | 尚無獨立斷線寬限與完整退避；拒絕／踢出不得當暫時斷線 |
| J12／P1 | 時限／重啟 | 預設最長 12 小時；graceful stopped 可恢復未到期排程 | 結束 session 通知本機逐字稿佇列，後處理不阻擋關閉 Meet 頁面 | crash 的 session／排程恢復、睡眠／網路復原仍有限 |

### 影音、指示與完整性

| ID／優先 | 能力 | 基線 | 本輪程式 | 後續／限制 |
| --- | --- | --- | --- | --- |
| R01／P0 | 錄影指示 | 合成相機 RECORDING；停錄關閉；無合成裝置不開實體相機 | pause／stop 延續此行為，麥克風保持關閉 | 提示卡不代替參與者同意或組織政策 |
| R02／P0 | self-view popup | 只識別指定英文提示與 Got it，observer 處理延遲出現 | 保留相同保護與 fixtures | 其他語言／UI 變更須補 fixture；不修改既有影片 |
| R03／P0 | 視窗與影像 | Chrome PID＋唯一標題會議碼；H.264、15fps、最寬 1440 | 合成 A/V 實錄有變動影格，結果綁定當次 job | 真實分享畫面與版型需 L3；不承諾所有視窗選擇都正確 |
| R04／P0 | 音訊 | 48kHz 雙聲道系統音訊；不擷取實體麥克風 | 合成音可檢出，MP4 有可解碼 audio/video | 不等於單分頁隔離或遠端發言品質；未有每人獨立音軌 |
| R05／P0 | 檔案驗證 | native finished＋正常退出＋ffprobe 正時長／影音影格 | catalog 暴露 starting／recording／verified／failed；僅 verified 可下載 | 目前沒有獨立 finalizing 狀態；收尾期間不可把 recording 或存在檔案當成 ready |
| R06／P1 | 分段 | 預設 600 秒，收尾／ffprobe 後開下一段 | metadata 增加 sessionId／segmentIndex；逐字稿按整場處理 | 換段有間隙；完整 session manifest、背景驗證／無縫分段尚未提供 |
| R07／P0 | 空間 | 每段開始檢查，預設至少 2GiB | diagnostics 回空間／門檻；逐字稿另估音訊暫存需求 | 未持續監測錄影中水位，也非硬保留容量 |
| R08／P0 | 權限／簽章 | 獨立已授權 App、permission preflight | 診斷不請求新授權、不重建或重簽 App | 新建置授權穩定性另案；不得用 repo 工作中斷錄影 |
| R09／P0 | 收尾 | stop marker／SIGTERM，等待 native finished；stopPromise 去重 | 控制先保留停止意圖再由處理迴圈收尾 | native／Node／ffprobe 期限與 LaunchAgent 30 秒退出期限仍需聯合驗證 |
| R10／P1 | crash | native 檢查 parent 存活後嘗試收尾 | failed 不提供成功下載、不用殘檔冒認成功 | 尚無完整 orphan 掃描／修復；SIGKILL／斷電不保證成品 |
| R11／P0 | 合成測試 | CLI 約 10 秒動畫＋660Hz 音 | 非同步 API／MCP、共鎖、90 秒期限、最新 20 jobs、report 身分驗證；L2 通過 | running → passed／failed／timed_out／cancelled；無測試取消 API；長時壓測另案 |

### 儲存、API、MCP 與營運

| ID／優先 | 能力 | 基線 | 本輪程式 | 後續／限制 |
| --- | --- | --- | --- | --- |
| S01／P0 | 本機成品 | recordings 下 MP4／sidecar／events；私人目錄與檔案權限 | 保留原片；transcripts 存 job／輸入 manifest／結果及匯出 | 所有內容及 metadata 可能含私人資料，不得提交公開 repo |
| S02／P0 | 列表／下載 | 原先只有活動檔／lastRecording | recording ID、limit 1–100、狀態／時長／codec／session、symlink 防護、單一 Range | 無 cursor 分頁／完整搜尋；API 只接受 ID，不接受任意路徑 |
| S03／P1 | retention | 無自動刪除 | 不新增刪錄影／逐字稿介面；影音測試僅限制 job metadata 歷史 | 成品與 transcript 歷史仍會累積；需另定預覽／容量／刪除策略 |
| A01／P0 | REST | `/healthz`、`/join` | `/v1` 控制／錄影／診斷／測試／逐字稿及 OpenAPI；舊路由同樣經邊界檢查 | webhook、SSE、公網服務未提供 |
| A02／P0 | 本機安全邊界 | 127.0.0.1，join 有 Origin／JSON／body 限制 | 全路由 Host allowlist、拒絕 Origin；POST 2KiB 與允許欄位限制；**刻意沒有 token auth** | 僅信任同機客戶端，無法隔離同機惡意程序；token／權限是後續，不可公開 port |
| A03／P0 | 重試／冪等 | 同活動 URL／recorder stop 去重 | 可選 Idempotency-Key：同路徑與 body 共用回應，衝突 409；最多 200 keys／1 小時，進程內有效 | 非 durable exactly-once；timeout 先查狀態，重啟後 key 不保留 |
| A04／P0 | 狀態／錯誤 | state、detail、字串 error | HTTP 類別＋控制 accepted/status；例外為 `{error}`，異步失敗在 job | 沒有統一 code/message/retryable schema；HTTP 200／202 不等於業務成功 |
| A05／P0 | 非同步工作 | tick 串行，native／ffprobe 會 await | 控制快速受理；影音測試立即保留資源；逐字稿持久佇列、單 worker | 並非所有慢工作都不影響 tick；無通用取消協定 |
| M01／P0 | MCP | 無 | 13 個 tools 對應 REST；JSON-RPC stdout 純淨，不另啟 Chrome／monitor | stdio 本身不是遠端授權；無 remote MCP／OAuth |
| M02／P0 | MCP 邊界 | 無 | 固定 127.0.0.1、受控 port／ID／參數、不跟 redirect；下載只回參照 | 大 transcript 限制 inline 大小；文字／檔名是資料，不是指令 |
| O01／P1 | 常駐／診斷 | LaunchAgent、caffeinate、status、doctor | API diagnostics 快取 30 秒，檢查 Chrome／recorder／權限／FFmpeg／磁碟 | 不驗證轉錄模型或語音品質；模型 setup check 另行執行；log rotation 待補 |
| O02／P0 | 公開發布 | 本機專案 | AGENTS 規定完成後測試、check、選檔審核，再向 `ZoneTwelve/meeting-mate` public origin commit／push；初始 `6614dab` 已核對遠端 main | 每次發布仍須核對 staged 內容／origin／push；不得改為 private、force push 或覆寫別的 remote |
| O03／P1 | 定期追蹤 | 無 | read-only repo watcher 程式／規範由獨立工作整合，安裝為明確分開步驟 | 不 fetch／測試／stage／commit／push，不判斷功能完成，不改 recorder LaunchAgent；見 [repository.md](repository.md) |

### 本輪新增：自動本機逐字稿

| ID／優先 | 能力 | 本輪程式契約 | 後續／驗收界線 |
| --- | --- | --- | --- |
| T01／P0 | 自動觸發 | transcriptEnabled 預設 true；整場 session 結束、片段收尾後排工作；pause／換段不排 | 無 verified 片段時不建 job；任一已索引片段未 verified 時拒絕，錯誤記錄而不妨礙關頁；佇列滿沒有自動補投 |
| T02／P0 | 來源範圍 | 手動 POST 只接受 catalog recordingId；有 session 則處理同 session 全部已索引片段；無 session 的舊錄影只處理單檔 | 活動 session 拒絕；全部須 available／verified／正時長；不掃任意路徑、不默默批次轉錄全部舊影片 |
| T03／P0 | 本機 ASR／模型 | setup 在本機安裝 Python 3.12 環境及模型；runtime 用 faster-whisper small CPU int8、sherpa-onnx 本機模型 | 首次下載要網路／空間；目前 setup 限 macOS arm64；缺模型 job 失敗而不下載；四格式真模型輸出已驗證，品質仍未通過 |
| T04／P0 | Speaker 分群 | 同 session 音訊串接後做一次全場 diarization；ASR 分窗，回傳穩定 session 內 Speaker N | 實驗性，實測有嚴重過度分群；已知人數建議提供 numSpeakers。不是真人識別、不跨會議認人、不產生每人獨立音軌 |
| T05／P0 | 時間軸 | 秒為單位，start/end、speakerId、text、recordingId；offset 從第一段 startedAt 起算，保留 pause／換段間隙 | 字幕是整場時間軸，不是每段從零；沒有可直接播放的合併影片／完整 gap manifest |
| T06／P0 | 模糊／重疊 | 詞以重疊時間配到最相符聲音；無可靠聲音／來源對齊可省略並附 warning；無可理解語音可輸出空稿 | 不是完整重疊語音分離；尚無 confidence 校準、unknown 編輯及姓名 mapping |
| T07／P0 | 成品 | JSON 原結構、TXT、SRT、VTT；speakers、segments、language、engine、warnings；結果驗證 job 身分及來源時間 | JSON 不包含已確認姓名；正確格式不證明文字／speaker 準確；字幕需要人工抽查 |
| T08／P0 | 佇列／重試 | queued／running／completed／failed；最多 20 queued＋1 worker；同來源 metadata、選項與 engineVersion 去重；failed 再提交為新 job | 沒有取消 API／自動失敗重試；fingerprint 非全音訊內容 hash；重試用新 HTTP key |
| T09／P0 | 資源／恢復 | 忙碌不啟 worker；自己的 process group 可 SIGSTOP／SIGCONT；worker 四小時牆鐘期限；優雅中斷或恢復 running 會重排 | 暫停仍占記憶體且期限不停；非硬 CPU／RAM 配額，主迴圈觀測有延遲；全長壓測待做 |
| T10／P0 | 上限 | API numSpeakers 1–20 或省略自動；worker 最多 1000 段、合計 12 小時音訊；worker JSON 16MiB，API 驗證上限 20MiB | 超限／缺模型／低空間為可查失敗，不暗中改用雲端；phase／progress 不是整場 ETA |
| T11／P0 | API／MCP | GET／POST `/v1/transcripts`、GET `/:id`、GET `/:id/file?format=json\|txt\|srt\|vtt`；MCP create／list／get | 沒有姓名修改、取消、刪除端點；GET 可回 failed job，不能以 HTTP 成功冒認工作成功 |

## 尚需追蹤的風險

| ID／優先 | 目前處置與剩餘風險 |
| --- | --- |
| K01／P0：測試與加入競態 | API 已共鎖，包含候場／pause／pending join；直接 `pnpm run test:av` 仍只掃描現況，不能與可自行加入的服務並行。優先使用 test:live／API。 |
| K02／P0：同機信任 | Host／Origin 已加，token 未實作。健康、錄影與逐字稿均可能包含私人內容；只供可信任的同機程式，禁止反向代理公開。 |
| K03／P0：控制交錯 | tick guard 與 stop／pause 意圖已實作，關鍵 await 後重查；stopRecording 會先清 recorder 參照，故不能僅靠 recordingFile 判斷閒置。持續擴充交錯測試。 |
| K04／P1：換段／驗證等待 | ffprobe 最多 60 秒，換段及人數觀測可能延遲；尚未量測所有間隙，不承諾無縫或精準 30 秒離會。 |
| K05／P1：服務退出期限 | LaunchAgent ExitTimeOut 30 秒可能小於 native／Node 收尾加 ffprobe 時間；慢磁碟／驗證仍待隔離測試。 |
| K06／P1：磁碟 | 段首及逐字稿啟動有空間檢查，但不是持續水位監測或硬容量預留。 |
| K07／P1：人數可信度 | 隱藏／舊 badge、聊天中的 only-one 文字可能影響後備判斷；需真實 fixtures，不把 unknown 當確知空房。 |
| K08／P1：斷線計時 | loading 還使用加入／嘗試時間而非獨立 disconnectedAt；長通話一次 UI 不辨識可能提早 timeout。 |
| K09／P1：crash 恢復 | native 可能收尾但 sidecar 尚未 verified；逐字稿只處理 catalog 可驗證來源，不能自動補救漏錄或未知片段。 |
| K10／P1：身分 metadata | recorder username 是設定訪客名稱；不能推導實際帳號名稱，更不能拿來命名 speaker。 |
| K11／P1：合成證據範圍 | L2 證明非靜音／非靜止，不證明真實遠端聲音、目標分享畫面、音源隔離或長時同步。 |
| K12／P1：長任務期限 | 影音測試有 90 秒期限；逐字稿有四小時牆鐘期限，但 SIGSTOP 時仍計時；過長會議／頻繁新會議可能使工作超時。 |
| K13／P1：索引完整性 | sessionId／segmentIndex 及共同 offset 已加入；損壞 sidecar 會略過，尚無獨立完整 session manifest 證明沒有缺段。 |
| K14／P1：轉錄品質／資源 | 全場 diarization 維持跨段分群，但不是準確率保證；重疊詞只歸一人，SIGSTOP 不釋放 RAM，需長音訊與繁中多人真模型 baseline。 |

## 未來能力與交付判準

未來保留：人工姓名 mapping／修訂、內容 hash、取消／刪除／優先序、明確缺口與單片字幕、錯字修訂、重疊語音與品質評估；摘要／決策／行動項目必須引用逐字稿時間。日曆需明確加入規則，不自動授權寄訊／代答；Zoom／Teams、內容搜尋、備份、多使用者、多場同錄及其他 OS 均需新設計與驗收。

完成說法分開使用：L1 是「程式／模擬流程通過」；L2 是「本機合成影音實錄通過」；T2 是「特定樣本的真模型轉錄已驗證」；L3 才是「本輪真實 Meet 端到端通過」。公開發布另須依 [AGENTS.md](../AGENTS.md) 完成功能驗收、staged diff 私密資料審核、origin 核對及遠端 push 驗證；repo watcher 的計時或 dirty 狀態不構成發布依據。
