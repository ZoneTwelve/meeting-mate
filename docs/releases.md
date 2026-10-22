# CLI 與 GitHub Releases

此功能只發佈到公開的 `ZoneTwelve/meeting-mate` **GitHub Releases**；`package.json` 保持 `private: true`，不發佈 npm registry。新增 workflow 不等於已發佈版本：必須由維護者檢查後推送版本 tag，且所有 release jobs 成功。

## 下載的是什麼？

| 資產 | 用途 | 還需要什麼？ |
| --- | --- | --- |
| `MeetingMateRecorder-vVERSION-macos-arm64.zip` | Apple Silicon 的原生 ScreenCaptureKit 錄影 App | macOS 15+、使用者授予畫面／系統音訊錄製權限 |
| `MeetingMateRecorder-vVERSION-macos-x64.zip` | Intel Mac 的原生錄影 App | 同上；逐字稿自動安裝目前只驗證 Apple Silicon |
| `meeting-mate-cli-vVERSION.tgz` | Node CLI、服務原始碼、MCP、必要腳本與說明文件 | Node.js 22+、pnpm；完整服務另需 Chrome、FFmpeg／ffprobe |
| `SHA256SUMS` | 三個下載檔案的 SHA-256 | `shasum -a 256 -c SHA256SUMS`，三個資產均須在同一目錄 |

**CLI 不是單檔 standalone binary／Node SEA**，也沒有內附 Node、依賴套件、Chrome、FFmpeg、Python 環境或語音模型。原生 ZIP 內是 `.app`，其中包含編譯好的 Mach-O executable；只有錄影器是原生二進位檔。

### CLI 安裝與使用

下載指定版本的 `.tgz`，將下列 `VERSION` 換成版本號，再解壓到一個新的目錄；不要覆蓋正在使用的專案：

```sh
mkdir meeting-mate-release
tar -xzf meeting-mate-cli-vVERSION.tgz -C meeting-mate-release
cd meeting-mate-release/package
pnpm install --prod --frozen-lockfile
pnpm run cli --help
```

`package/` 是完整的 runtime bundle。若只想控制現有服務，請指定原本存放 `config.json` 與 `.env` 的本機專案：

```sh
pnpm run cli --project /absolute/path/to/meeting-mate status
pnpm run cli --project /absolute/path/to/meeting-mate join https://meet.google.com/abc-defg-hij
```

連結是虛構示例，請換成自己的會議。CLI 不會自行啟動服務、登入 Google 或略過主持人核准；服務必須先啟動。`queued` 只是受理，不是已加入或已完成錄製。

在原始碼 checkout 中也可以使用同樣的 `pnpm run cli` 指令。自動化若只需要純 JSON，可用 `pnpm --silent run cli status`，避免 pnpm 的 script 標頭混入輸出。

如需終端機直接輸入 `meeting-mate`，可在解壓後的 `package/` 執行 `pnpm link --global`（需先設定 pnpm 的全域 bin 路徑）。或一直使用 `node /absolute/path/to/package/bin/meeting-mate.mjs`，不必全域安裝。

| 指令 | 行為 |
| --- | --- |
| `meeting-mate help` | 不讀 `.env`／設定、不連 API |
| `meeting-mate status` | 顯示服務與會議狀態 |
| `meeting-mate join <MeetURL>` | 提交加入並錄影請求 |
| `meeting-mate stop [MeetURL]` | 完成錄影並離開會議 |
| `meeting-mate pause [MeetURL]` | 完成當前片段，留在會議 |
| `meeting-mate resume [MeetURL]` | 恢復錄影，開新片段 |
| `meeting-mate recordings [limit]` | 列出錄影，預設 50，最多 100 |
| `meeting-mate recording <recordingID>` | 讀取單一錄影 metadata |
| `meeting-mate transcript <recordingID> --speakers 2 --language zh` | 提交本機轉寫工作；兩個選項皆可省略 |
| `meeting-mate transcripts list [limit]` | 列出逐字稿工作 |
| `meeting-mate transcripts get <jobUUID>` | 取得工作狀態、結果與下載連結 |

設定目錄依序選用 `--project /absolute/path` → `MEETING_MATE_PROJECT` → 目前工作目錄；明確指定的路徑必須是本機絕對路徑。CLI 讀該目錄的 `config.json`／`.env`，不從安裝 CLI 的位置猜測專案，也不使用 `MEETING_MATE_CONFIG` 覆蓋它。環境中的 `MEET_USERNAME` 優先於 `.env`，與服務設定保持一致。

輸出為 JSON；exit code `0` 是成功受理／讀取、`1` 是設定或 API 錯誤、`2` 是參數錯誤。連線固定為 `127.0.0.1` 與設定的 `healthPort`，不支援遠端 API 或代理伺服器。CLI 不自動重試寫入請求；若逾時，先查狀態，避免重複操作。

逐字稿是非同步工作，必須等到 `completed`。`--speakers 2` 提供已知人數提示，不證明分群正確，也不會產生真人姓名。詳見 [逐字稿限制](transcript.md)。

### 原生 App 安裝注意事項

ZIP 內的 `Meeting Mate Recorder.app` 僅使用 **ad-hoc 簽章**，沒有 Developer ID 或 Apple notarization。macOS 可能阻擋首次開啟；先核對來源與 checksum，再依系統的「隱私權與安全性」提示處理，不要全域停用 Gatekeeper。原生 App 由服務呼叫，不是完整的圖形介面應用程式。

首次安裝時，在沒有會議／錄影的狀態下，將 App 放進專案的 `.meeting-mate/`，保留原名：

```text
<project>/.meeting-mate/Meeting Mate Recorder.app
```

再依 [README](../README.md) 準備提示卡與權限。安裝預編譯 App 不需要再執行 `build:recorder`。已有授權且正常運作的 App **不要為 CLI 更新而替換或重簽**；原生版本替換可能觸發重新授權。CI 的簽章不會授予使用者電腦的 TCC 權限。

## CI 做什麼、不做什麼？

| 觸發 | 驗證／輸出 | 不會做 |
| --- | --- | --- |
| Branch push、PR、手動 CI | Linux Node 22／24、macOS 15 arm64／Intel Node 22；語法檢查、Node 測試、無模型 Python 測試、CLI 白名單打包；macOS 另編譯原生 App、驗證簽章／plist／架構及 ZIP 解壓後簽章 | 不登入 Meet、不讀私人設定、不下載語音模型、不發佈 |
| `v*` tag | 版本一致性與測試；兩種 macOS 原生 App；Node CLI；checksum | 不發佈 npm、不使用 Developer ID、不觸發真實錄影 |
| 所有 release jobs 成功 | 最後一個 job 建立 GitHub Release 並上傳三個資產及 `SHA256SUMS` | 不覆寫已有 release、不移動 tag |

只有最後的 release job 有 `contents: write`；其餘為 `contents: read`，checkout 不保留憑證。動作固定至 commit SHA。原生編譯／ad-hoc 簽章只在 GitHub 的全新 checkout 進行，不碰開發者已授權的本機 App。

runner 使用目前官方列出的 `macos-15`（arm64）與 `macos-15-intel`（x64）；未來標籤停止供應時需調整 matrix。[GitHub runner 文件](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

Linux 只驗證可攜式控制邏輯，不代表支援 Linux 原生錄影。既有 `plutil` 原生測試在非 macOS 平台有 skip guard；macOS jobs 才會執行。CI 的 mock／封裝測試和編譯成功，**都不是 ScreenCaptureKit 實錄或真人 Meet／分群準確率驗收**。

## 維護者發版流程

1. 完成功能、隱私稽核與測試；整合者確認 authorized origin，再 commit／push。不要將未完成工作包入版本。
2. 更新 `package.json` 的版本；保持 `private: true`，確認 `bin.meeting-mate` 為 `bin/meeting-mate.mjs`。
3. 在目標 commit 執行 `pnpm test`、`pnpm run check`、`pnpm exec node --check bin/meeting-mate.mjs` 與 `pnpm run test:transcript`；實錄與品質測試另在本機進行。
4. 審核 `scripts/package-release.mjs` 的 `RELEASE_FILES`；新增 runtime 檔案需明確加入，不以整個目錄自動取代。
5. **只有決定正式發版時**，維護者才建立與版本完全一致的 tag，例如 `v0.2.0`，並推送該 tag。這份功能不會替你建立／推送 tag。
6. 等待 Release workflow 完成，確認兩種原生架構、CLI 與 checksum 都存在。`-rc.1` 等版本會標記為 prerelease；已存在的 Release 不會被 `--clobber` 覆蓋，失敗需人工檢查。

`scripts/package-release.mjs` 可單獨檢查封裝，不必重建錄影器：

```sh
pnpm run release:pack --kind cli
```

預設輸出在已忽略的 `.meeting-mate/releases/`；同名檔案存在時拒絕覆寫。腳本使用明確檔案清單，不加入 `config.json`、真正的 `.env`、錄影、逐字稿、browser profile、models、logs、`node_modules` 或 Git 歷史；同時拒絕白名單路徑中的 symlink。**這是內容範圍限制，不是秘密掃描器**：發布前仍須人工審查白名單檔案本身。

相同來源 bytes 與 `SOURCE_DATE_EPOCH` 會得到固定排序、uid／gid、權限及時間戳的 archive；CI 使用 tag commit 的時間，本機預設為 `0`（ZIP 至少使用 1980 年）。SHA-256 從最終 archive bytes 計算。這不保證不同 Swift／SDK／Node／zlib 版本編譯、壓縮後完全 bit-identical；尤其原生 binary 與簽章會受工具鏈影響。可重現驗證應使用同一工具鏈與輸入。
