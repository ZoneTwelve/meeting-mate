# Repository 與本機變更追蹤

程式已發布至公開的 [`ZoneTwelve/meeting-mate`](https://github.com/ZoneTwelve/meeting-mate)，初始 commit 為 `6614dab`，已核對遠端 main。公開代表任何人都可能下載已推送的內容；不要把個人會議資料放進 Git。後續版本進度以 GitHub 與交付報告為準；CLI／binary 的打包與 tag 發版見 [releases.md](releases.md)。

## 兩種不同的流程

| 流程 | 觸發時機 | 允許的動作 |
| --- | --- | --- |
| 本機定期追蹤 | 安裝後，預設每 30 分鐘 | 讀取 Git 狀態與差異統計，寫入本機 metadata |
| 功能完成後發布 | 開發者／整合代理完成驗收與隱私稽核後 | 明確選取完成的檔案或 hunks，commit，push 到指定公開 origin |

定時器永遠不會自行 stage、commit、push 或 fetch，也不會執行測試、重啟錄影器、呼叫 GitHub API，或判斷功能完成。上游 ahead/behind 僅反映本機最後已知的 remote-tracking refs，不是即時 GitHub 狀態。自動發布政策由 [AGENTS.md](../AGENTS.md) 約束實際開發流程，不是定時器功能。

## 手動檢查與安裝

以下指令在 checkout 根目錄執行，不需填入任何使用者專屬絕對路徑：

```bash
# 單次讀取 Git 狀態，寫入本機報告；不安裝排程
pnpm exec node scripts/repo-watch.mjs once

# 只查看排程與最後一次報告；不觸發新快照
pnpm exec node scripts/repo-watch.mjs status

# 審查通過、確定要啟用後才執行：預設每 30 分鐘
pnpm exec node scripts/repo-watch.mjs install

# 可選：1～1440 分鐘的整數間隔
pnpm exec node scripts/repo-watch.mjs install --interval-minutes 60

# 停止並停用排程，之後登入也不會自行恢復；install 可重新啟用
pnpm exec node scripts/repo-watch.mjs stop
```

本次程式交付本身不會安裝服務。`install`、`status`、`stop` 使用 macOS 使用者 LaunchAgent，名稱為 `com.meeting-mate.repo-watch`，與錄影服務 `com.meeting-mate.monitor` 分開。安裝時會保存目前 checkout 與 Node 的絕對路徑；搬動 checkout 或更換 Node 位置後須重新檢查設定。若同名服務屬於另一個 checkout，指令會拒絕覆寫；請先在原 checkout 停用並人工處理舊設定。

`install` 會立即執行一次檢查，再按間隔執行。電腦睡眠或未登入時不保證準時執行；這不是永遠在線的監控服務。`stop` 保留 plist 與歷史資料，不刪除程式、報告或錄影。重新安裝既有的同 checkout 設定時，僅保留一份 `.previous` 設定備份。

## 報告與隱私界線

- `.meeting-mate/repo-status.json`：最後一次檢查時間、狀態、HEAD hash、ahead/behind、staged/unstaged/untracked/conflict 數量、最多 200 筆路徑，以及增刪行數／binary file 數量統計。
- `.meeting-mate/repo-changelog.jsonl`：metadata 改變才新增紀錄，最多 100 筆且不超過 128 KiB；每筆最多 50 筆路徑。不是檔案備份或完整稽核軌跡。
- 這兩個檔案都以原子替換寫入，權限為 `0600`，位於 Git 忽略的目錄。Git 指令設有逾時及輸出上限；並行的同 checkout 快照會略過其中一次。
- 只保存路徑與統計等 metadata，不保存檔案內容、patch、commit 訊息、remote URL、GitHub token 或原始 Git 錯誤輸出。已知的機密／媒體／模型路徑與 Meet code 會遮罩；一般檔名仍可能透露專案資訊，因此報告也不應公開。
- 若 `.git` 尚未初始化，快照顯示 `not_initialized`，不會自動初始化 Git 或建立遠端。若 Git 根目錄不是此 checkout，顯示 `wrong_repository`。Git 摘要失敗則記錄 `error`，不保存可能含敏感資訊的 stderr。
- 忽略目錄內的內容變更不會被追蹤。未追蹤目錄採 Git 的目錄摘要模式，不保證逐一列出新目錄內的檔案。相同行數的內容替換若 metadata 未變，可能不新增歷史；工具不讀取內容做版本備份。
- 排程不寫無上限的 stdout/stderr log；其輸出指向 `/dev/null`。查看最後成功的報告時間以確認是否持續執行。

`.gitignore` 排除 `config.json`、`.env` 及變體（保留 `.env.example`）、錄影、逐字稿、`.meeting-mate/`（含 Chrome profiles）、Python 環境、模型、快取與本機 logs/media。不要用 `git add -f` 繞過這些邊界。測試與範例也不得含實際會議網址或登入資訊。

## 功能完成後的發布檢查

1. 確認功能真的完成；執行相關 `pnpm` 測試與 `pnpm run check`，記錄未能執行的整合測試及原因。
2. 檢查現有 staged 與 unstaged 變更，保留別人的修改。僅明確 stage 已完成、已審查的檔案或 hunks；不要一口氣加入整個 dirty worktree。
3. 檢查 staged 檔案清單及 diff，排除機密、真實 Meet code、個資、錄影音、逐字稿、profiles、模型與其他 runtime artifacts。初次公開前也要確認沒有把機密放入待推送的歷史。
4. 確認 `origin` 指向 `ZoneTwelve/meeting-mate`，然後為該功能 commit 並 push。不可 force-push、覆寫不相關 repo 或變更使用者全域 Git 設定。
5. 驗證遠端結果。驗證或授權失敗時停在本機，回報原因；不要把「排程已安裝」或「commit 已建立」誤報成已推送。

這些規則使用根目錄 `AGENTS.md` 作為持久的專案指引，符合 [OpenAI 的 AGENTS.md 說明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。實際發布仍取決於當次請求與被分配的寫入權限；本輪委派工作只實作工具與規範，首次 commit/push 由整合者完成。

## 測試

```bash
pnpm exec node --test test/repo-watch.test.mjs
pnpm run check
```

測試使用暫存 Git repository 與假的 LaunchAgent 執行介面，不安裝服務、不存取 GitHub、不改動本專案 index，也不啟動錄影器。
