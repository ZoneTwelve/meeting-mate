# Meeting Mate Todo

本輪範圍已更新：本機 REST API、MCP、錄影測試，**以及錄影結束後自動產生帶時間戳與 Speaker 標籤的本機逐字稿**。不使用雲端轉錄或 Playwright。姓名對應仍是未來功能。

下列「程式已實作」不等於已部署或實錄驗收完成；證據分層見 [測試計畫](docs/test-plan.md)，能力與限制見 [需求矩陣](docs/requirements.md)。

## P0：本輪程式已實作

- [x] REST：`/v1` 加入、停止、暫停、恢復、會議狀態、錄影清單／下載、診斷與 OpenAPI；保留 `/healthz`、`/join`。
- [x] 控制狀態機：stop 撤銷待加入／候場並收尾；pause 保留通話及互斥，resume 在同一 session 新建片段；錄影前仍須獲准入會。
- [x] 本機請求邊界：綁定 `127.0.0.1`、Host allowlist、拒絕 Origin、JSON／2 KiB body／欄位限制。**沒有 token auth**，只適用可信任的同機程式，不可公開連接埠。
- [x] 錄影目錄索引、受控 ID、symlink／路徑穿越防護、verified-only MP4 下載及單一 HTTP Range；不刪除既有錄影。
- [x] 非同步合成影音測試 job、90 秒期限、結果驗證及歷史；API 測試與會議／排程共用互斥。
- [x] MCP stdio 代理會議、錄影、診斷、測試及 transcript 建立／列表／查詢；stdout 僅協定，不另啟錄影服務。
- [x] session 真正結束後自動排逐字稿；pause／換段不提前觸發。選定一段時納入同 session 全部片段，全部 verified 才可開始；舊錄影無 session 則僅處理該檔。
- [x] 本機模型 setup 與離線 worker：faster-whisper ASR、sherpa-onnx diarization；執行時只讀本機模型，不上傳音訊或臨時下載模型。
- [x] 全場音訊一次 speaker clustering，跨段共用 `speaker_1`／`Speaker 1` 等標籤；文字時間映射回第一段起算的共同時間軸，保留 pause／換段間隙。
- [x] JSON／TXT／SRT／VTT、來源 recording ID、時間戳、模型資訊及 warnings；不猜真人姓名，不把重疊發言當已分離音軌。
- [x] 單一 worker、最多 20 筆等待工作、四小時 worker 期限、同來源設定去重、失敗可重新提交；重啟保留佇列，受中斷工作重排。
- [x] 會議／影音測試優先；worker 暫緩啟動或對自己的 process group 使用 SIGSTOP／SIGCONT。暫停的牆鐘時間仍計入四小時期限。
- [x] 已有 API／MCP／錄影測試管理／逐字稿佇列與格式的單元及 mock 整合測試；Python 有時間軸、speaker 分配及拒絕網路的測試。

## P0：整合驗收與發布

- [x] L2：2026-10-23 00:00:50 Asia/Taipei，`pnpm run test:live` 經官方 SDK → MCP → API → 既有授權原生 App 通過；13 tools、10.061667 秒 H.264／AAC、有聲且有變動影格。指標與私人報告位置見測試計畫。
- [x] 整合者最新回報：Node 142 passed（含 14 項 CLI／封裝測試）、Python 27 passed、`pnpm run check` 46 個 JavaScript 檔案通過；後續程式變更仍須重跑相關測試。
- [x] T2 功能：真模型已產生逐字稿，JSON／TXT／SRT／VTT 四格式可用；這不等於文字或 Speaker 準確率通過。
- [ ] T2 品質：70 秒樣本自動分出 5 組（含約 0.26 秒短組），486.9 秒樣本分出 21 組，出現嚴重過度分群。使用者推估短樣本有 2 人，但尚無人工正解；指定 2 人重跑後，第二組仍只有 0.26 秒，並未通過聲音歸屬驗證。Diarization 目前為實驗性，提供 numSpeakers 也不保證正確，仍需改善模型與校對。
- [ ] 來源音訊完整性：現有錄影器只擷取系統音訊，不擷取本機麥克風；需核對樣本是否實際包含所有人的聲音。未錄到的聲音不能靠分群補回，不能直接將此當作分群錯誤的確定原因。
- [ ] 整合確認結束 session → 自動排工作 → 完成／失敗可查；服務升級只在閒置時進行，不中斷正式會議。
- [ ] L3：主持人放行、遠端發言、其他人全離場、自動收尾及逐字稿抽查。本輪尚未執行，不能以合成測試代替。
- [x] 公開發布至使用者授權的 **`ZoneTwelve/meeting-mate` public repo**。已確認 public visibility、SSH origin 與第一筆 commit `6614dab` 的遠端 main SHA 相符；僅公開經審查的程式、文件與測試。
- [x] 完成的功能經測試、`check` 及逐檔機密／私人資料審核後，由整合者選檔 commit／push；先驗證 origin，禁止 force push 或夾帶未完成工作。此規則持續適用，見 [repository.md](docs/repository.md)。
- [x] 已安裝每 30 分鐘執行的 read-only repo watcher，驗證狀態 ready；它只觀察本機 Git 並寫受限 metadata，不會 fetch、測試、stage、commit、push 或認定功能完成，也不修改錄影 LaunchAgent。
- [x] CI／Release 與 CLI：一般 push／PR 跑 Linux／macOS 測試及 macOS 雙架構編譯驗證；版本 tag 才建立 GitHub Release，提供原生 App ZIP、Node CLI TGZ 與 SHA256SUMS。CLI 白名單封裝、解壓安裝與讀取本機 API 已實測；尚未建立 tag／正式 Release，遠端驗證以 Actions 結果為準。見 [發版與 CLI 文件](docs/releases.md)。

## P1：錄影可靠性與營運

- [ ] 量測並縮短換段間隙；將耗時驗證與下一段開始分離，維持單一擷取資源。
- [ ] 在現有 sessionId／segmentIndex／offset 基礎上建立完整 session manifest，明列 pause、斷線、丟失區間、failed／orphan 檔及可播放媒體對照。
- [ ] 錄影中持續檢查磁碟水位並提早安全收尾；容量不足不自動刪舊片。
- [ ] 協調 LaunchAgent 30 秒退出期限、recorder 收尾與 ffprobe 最長 60 秒，測試慢磁碟下 metadata 落盤。
- [ ] crash 後掃描 orphan MP4／sidecar、明示未知／待驗證，提供受控恢復；存在 MP4 不等於 verified。
- [ ] 分離斷線寬限與加入等待；拒絕／踢出不當作暫時斷線重入；重試有上限與退避。
- [ ] 增加可見人數、矛盾／未知 badge、多語 popup fixtures；區分剛入空房與所有人離場。
- [ ] 分開記錄設定訪客名稱、帳號模式、已確認顯示名稱；不得從 `MEET_USERNAME` 推論任何發言人的身分。
- [ ] 量測其他 Chrome 音源污染、長時音畫同步、凍結／靜音與視窗版型；不承諾單分頁音訊隔離。
- [ ] token defense、細分權限、穩定錯誤 code／retryable、事件時間線、log rotation；目前 loopback／Host／Origin 不等於使用者驗證。
- [ ] 定義影片、逐字稿及歷史 jobs 的 retention／容量策略；預設不刪除，未來清理須有預覽、活動檔保護及復原設計。

## P1：逐字稿品質與擴充

### 尚未提供的能力

- [ ] 人工 `speakerId → displayName` 對應、修訂及清除；保留來源、原 Speaker ID 與文字，改姓名不必重跑 ASR。參與者列表、發言時間相近或 bot 名稱不等於真人身分證據。
- [ ] 更可靠的重疊發言處理與每人獨立音軌；目前每個詞只選最相符聲音，v2 已保留缺乏可靠對齊的詞為 Unknown speaker 並附 warning。
- [ ] 用人工正解樣本量測繁中、中英混用、短句、長靜音、多人的 ASR／speaker 錯誤與時間偏移；不得把模型支援語言當已達品質門檻。
- [ ] 更完整的取消／刪除／明確 retry API、佇列滿時的自動排程補償、工作優先序與 ETA。現有失敗重試是再次 POST 建立新 job，沒有取消端點。
- [ ] 來源內容 hash 與所有模型／設定版本納入去重；現有 fingerprint 使用來源 metadata（含大小／mtime）、選項及 engineVersion，不是完整音訊 hash。
- [ ] worker 超時與暫停時間策略、全長記憶體／CPU／磁碟量測、硬資源配額及 crash 後殘留程序／暫存清理；SIGSTOP 不代表已釋放記憶體。
- [ ] 字幕對單段影片的 offset 匯出／媒體合併；目前字幕使用整場共同時間軸，不能直接套到每段 MP4。
- [ ] ASR 視窗／片段接縫、來源 wall-clock 重疊、長會議及無語音樣本的真模型驗收；不要把單次合成測試當通用準確率。

### 後續驗收

- [ ] 同一人在跨段／pause 後維持正確分群，或明示不確定；不跨 session 假定 `Speaker 1` 是同一人。
- [ ] 真模型沒有可理解語音時輸出空結果及 warning，不杜撰句子；模型缺失／錯誤語言／低磁碟／worker 超時均有可查終態。
- [ ] 量測本機模式沒有會議音訊外傳；目前 worker 的離線參數與 Python network audit 不是作業系統級 network sandbox。
- [ ] 模型缺失時不暗中下載；首次安裝所需網路、容量與模型使用條件保持可見。

## P2：選配擴充

- [ ] 會議摘要／決策／行動項目：依據已完成逐字稿並附時間來源，區分原話與推論。
- [ ] 日曆：明確選擇時區與加入規則；邀請不自動授權寄訊、代答或加入所有會議。
- [ ] Zoom／Teams：重新驗證登入、核准、人數、指示、視窗／音源與結束條件。
- [ ] 搜尋、備份、多場同錄、遠端 API／MCP、多使用者或其他 OS：另設計權限及資源隔離；不直接公開現有 loopback 服務。
