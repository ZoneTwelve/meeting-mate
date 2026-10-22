# 本機逐字稿與發言人分群

這個 Python worker 將已完成的錄影轉成帶時間戳的逐字稿，標示 `Speaker 1`、`Speaker 2` 等聲音分群。這不是聲紋身分辨識，也不會自動推斷 Google Meet 參與者的真實姓名。錄影結束後排隊、自動觸發、API／MCP、TXT／SRT／VTT 匯出由 Node 主程式負責；本文件描述其本機推論介面。

## 安裝

需要 macOS Apple Silicon、`uv`、`ffmpeg`、Node，以及安裝時至少 2.5 GiB 可用空間。

```sh
pnpm run transcript:setup
# 等同 node scripts/transcript-setup.mjs
node scripts/transcript-setup.mjs --check
```

安裝程式建立 `.meeting-mate/transcript-venv`（Python 3.12），不修改系統 Python、不讀取 `.env`、不重建或重新簽署原生錄影器。Python 推論套件固定於 `requirements-transcript.txt`；模型只有約 532 MB 下載量，不安裝 Torch／CUDA。

模型路徑：

- `.meeting-mate/models/faster-whisper-small/`：多語言 Whisper small，CPU int8。固定模型 revision `536b0662742c02347bc0e980a01041f333bce120`。
- `.meeting-mate/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`：語音與說話人切段。
- `.meeting-mate/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`：說話人 embedding。
- `.meeting-mate/models/transcript-models.json`：安裝完成資訊與實際 SHA-256。

模型使用官方公開下載位置，不需要 Hugging Face token、雲端語音服務或接受 gated 模型條款。只在安裝階段連網下載套件及模型；推論設定 `HF_HUB_OFFLINE=1`、`HF_HUB_DISABLE_TELEMETRY=1`、`TRANSFORMERS_OFFLINE=1`、`DO_NOT_TRACK=1`，並使用 `local_files_only=True` 與本機模型路徑。Python audit hook 也會拒絕一般 Python 網路連線／DNS；這是額外防護，不是作業系統網路 sandbox。音訊不會上傳。

## Worker 介面

```sh
.meeting-mate/transcript-venv/bin/python scripts/transcribe.py \
  --manifest /absolute/path/input.json \
  --output /absolute/path/output.json \
  --models /absolute/path/.meeting-mate/models
```

輸入 JSON：

```json
{
  "jobId": "local-session-001",
  "language": "auto",
  "numSpeakers": null,
  "recordings": [
    {
      "id": "segment-1.mp4",
      "file": "/absolute/path/recordings/segment-1.mp4",
      "duration": 600,
      "startedAt": "2026-10-22T12:00:00Z",
      "endedAt": "2026-10-22T12:10:00Z",
      "offsetSeconds": 0
    },
    {
      "id": "segment-2.mp4",
      "file": "/absolute/path/recordings/segment-2.mp4",
      "duration": 300,
      "startedAt": "2026-10-22T12:11:00Z",
      "endedAt": "2026-10-22T12:16:00Z",
      "offsetSeconds": 660
    }
  ]
}
```

`language` 為 `auto` 或 Whisper 支援的語言代碼（例如 `zh`、`en`，不是 `zh-TW`）。自動模式從語音推斷主要語言，跨語言切換可能辨識較差。中文輸出保留原始 ASR 文字，可能是簡體或繁體，本輪不加入自動繁簡轉換。`numSpeakers` 可為 `null`（自動分群）或 1–20 的已知人數；參與者人數不等同實際有發言的人數，不應直接拿 Meet 參與者數強制設定。

`recordings` 依 `offsetSeconds` 排序、ID 不重複，最多 1000 個檔案與 12 小時實際音訊。`file` 必須是本機絕對路徑；Node 呼叫端仍須驗證它屬於已驗證錄影目錄。`duration` 用於資源預估與解碼上限；解碼長度明顯超過宣告長度時明確失敗，不會悄悄截掉後半段。`offsetSeconds` 是呼叫端計算的相對會議開始時間，允許暫停間隔；`startedAt`／`endedAt` 供呼叫端追溯，不用來重新推算 offset。

輸出 JSON：

```json
{
  "jobId": "local-session-001",
  "language": "zh",
  "duration": 960,
  "speakers": [{"id": "speaker_1", "label": "Speaker 1"}],
  "segments": [
    {"start": 662.12, "end": 666.88, "speakerId": "speaker_1", "text": "接下來討論錄影功能。", "recordingId": "segment-2.mp4"}
  ],
  "engine": {"asr": "faster-whisper", "model": "small", "diarization": "sherpa-onnx", "device": "cpu", "computeType": "int8", "offline": true},
  "warnings": []
}
```

`duration`、`start`、`end` 單位為秒，包含原始分段／暫停間隔。`engine` 另外包含實際套件版本、模型 revision、`pipelineVersion: 2` 與處理耗時。無可靠講者匹配的已辨識文字仍保留，`speakerId` 為 `null`，匯出器顯示 `Unknown speaker`，不額外發明一位 speaker。空白音訊輸出空的 `speakers`／`segments` 並成功完成；未識別到語言時為 `und`。不會以假的逐字稿填補空白。錯誤時不發布半成品 JSON；成功輸出採同目錄原子 rename，UTF-8、檔案模式 `0600`。

stdout 僅輸出逐行 JSON 進度，例如 `{"phase":"diarizing","progress":50}`。phase 依序為 `validating`、`extracting`、`diarizing`、`transcribing`、`exporting`、`completed`；`progress` 是各 phase 的 0–100 百分比。診斷與錯誤只到 stderr，不把逐字稿內容寫入進度 log。成功 exit 0；輸入／模型／推論錯誤 exit 1；取消 exit 130。SIGTERM／SIGINT 會中止子程序、清除暫存音訊；強制 SIGKILL／斷電無法保證清理，呼叫端應回收所屬 job 的暫存目錄。

## 時間戳與發言人限制

所有錄影先以 FFmpeg 解碼成一份連續的 16 kHz 單聲道音訊，整場一次分群以維持同一 job 跨段 Speaker ID。ASR 以有重疊的五分鐘窗口處理以限制記憶體，詞級時間戳依聲音區間重疊量分配說話人，遇到發言人或原始檔案切換時分段，再映回原始 offset。跨檔邊界的單詞只保留最大重疊來源，不重複文字。

分群沒有真人姓名；不同 job 的 `Speaker 1` 不保證是同一人。說話人數是估計，不是經確認的參與者人數。短句、相似音色、背景聲、遠距麥克風與交疊發言可能分錯、漏字或把同一人切成多群。交疊發言只選重疊較強的一位，並非分離多條音軌。speaker 的詞級對齊語音總長不足 1 秒時會附上 low-support warning，提醒可能過度分群；不擅自把它合併到其他人。無可靠講者區間對應的字保留為 `speakerId: null` 並附 warning；只有超出來源錄影時間軸的字會略過並警告。靜音、VAD 與語音區間檢查可降低幻覺，不能保證真實環境完全零錯誤。

暫存 PCM 每小時約 230 MB，另保留至少 1 GiB 磁碟餘裕。整場分群仍會使用隨會議長度增加的記憶體與時間；12 小時是輸入保護上限，不代表已完成 12 小時負載驗證。建議主程式一次僅執行一項轉錄工作，保留錄影優先權，允許取消與重試。

## 驗證

```sh
# 不下載模型、不讀取真實錄影的純 Python 測試
python3 test/transcribe_test.py

# 明確執行本機模型；用 macOS say 生成兩種聲音的兩段測試檔
.meeting-mate/transcript-venv/bin/python test/transcribe_test.py --smoke
```

合成測試資料與報告只存 `.meeting-mate/transcript-smoke/`。測試檢查真的產生文字、至少兩位聲音、跨分段 speaker ID 一致、15 秒暫停不被刪掉、靜音輸出為空，以及 stdout 進度格式。它不是多語言真實會議的辨識率評測；不應據此宣稱真實錄音準確率。

2026-10-23 本機驗證：Samantha＋Daniel 的 33.33 秒合成語音，在 `numSpeakers: null` 與預設 clustering threshold 0.5 下輸出 2 個 speaker、4 個發言段落，耗時 15.39 秒（CPU 2 threads），跨兩個來源檔案保留相同標籤與 15 秒暫停；3 秒靜音成功輸出空逐字稿。最初的 Samantha＋Reed 合成聲音非常相似，實測被合併為一群；沒有為通過測試更動 threshold。此合成結果為 v1 pipeline，v2 僅改變 unknown speaker 保留策略與品質警告，需由服務使用新版 fingerprint 建立新工作，不改寫已完成 job 的歷史結果。

整合端同日回報的真實錄影結果：70 秒錄影自動估計 5 位；486 秒錄影自動估計 21 位（31 段文字、30 次 speaker 切換），有明顯過度分群的疑慮。使用者表示 70 秒錄影「應該是兩位」，屬待確認資訊，並非逐段人工標註的 ground truth。這證明本機轉錄管線可執行，**不代表真實會議的 speaker 品質已通過驗收**。固定 `numSpeakers: 2` 只能約束分群數量，不能證明每段歸屬正確；應由整合測試人工抽聽並比對。未因這幾份資料擅改 threshold，後續需用有已確認發言人標註的多份會議資料評估／校準。

### 有限度 embedding 比較：未找到已驗證的修正

同日另以官方支援的 `nemo_en_titanet_small.onnx` 做隔離比較，使用相同 70 秒本機錄影、同一份 ASR 詞級結果及相同 threshold 0.5，並保留全部既有 job 結果。四次分群比較共耗時 27.43 秒：

| 模型 | 自動分群 | 指定 2 人時的詞級對齊語音總長 |
| --- | --- | --- |
| 3D-Speaker ERes2Net | 5 群 | 23.90 秒／0.26 秒 |
| NeMo TiTanet Small | 5 群 | 20.12 秒／4.04 秒 |

這裡的詞級總長不含字與字之間的停頓，因此和 UI 顯示的段落跨度不同。NeMo 固定兩群時分配較不極端，但自動分群仍是五群，且缺少逐段人工真值，**沒有證據足以宣稱已修好，正式預設未切換模型**。

現有錄影器程式明確設定 `captureMicrophone = false`（`native/Recorder.swift`）。若某位發言人的聲音只存在於這台 Mac 的麥克風輸入，必須先檢查來源音軌是否實際包含該聲音；ASR／diarization 無法補回未錄下的音訊。這是待核對的來源完整性問題，不能直接當作上述分群結果的確定原因。本輪未修改或重簽錄影器。

可重現的診斷工具：

```sh
# 僅在另行下載官方診斷模型後執行；不會自動下載、不改服務或現有 job
.meeting-mate/transcript-venv/bin/python test/transcribe_test.py \
  --compare-embeddings /absolute/path/to/authorized-job.input.json
```

這個診斷限制輸入最多 120 秒，報告寫入 `.meeting-mate/transcript-smoke/embedding-comparison-*/report.json`，只包含區間與統計，不輸出逐字稿原文。診斷模型來自 sherpa-onnx 的 [官方 embedding release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)，檔名 `nemo_en_titanet_small.onnx`，40,257,283 bytes，SHA-256 `ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e`；它不是預設安裝需求。模型與所有診斷輸出均留在被 Git 忽略的 `.meeting-mate/`，不應提交到公開 repository。

## 官方來源

模型選型與參數依 [faster-whisper 官方說明](https://github.com/SYSTRAN/faster-whisper)、[Systran small 模型檔案](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120)、[sherpa-onnx 分群模型說明](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html) 與 [官方 Python 分群範例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)。Whisper／pyannote 模型及 embedding 的使用仍須遵循各自授權；下載分段模型時會一併保留其 LICENSE。
