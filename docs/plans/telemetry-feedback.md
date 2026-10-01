# OpenTelemetry 與 Feedback 實作計畫

兩個互相配合的功能：以 OpenTelemetry 把每個 Run 的 agent 過程送到可觀測性 backend；以 `x-plan feedback` 讓人評價 Run 的產出，並把評價掛到產出該條目的 span 上。名詞定義見 [CONTEXT.md](../../CONTEXT.md)。

## 1. OpenTelemetry

### 1.1 定位

- **補充，不取代**檔案 trace。`traces/*.jsonl`、`*.md` 照舊永遠寫出；backend 不在線不影響 Run（[ADR 0013](../adr/0013-opentelemetry-supplements-file-traces.md)）。
- **預設關閉**。沒有啟用時不載入 SDK，只有零依賴的 `@opentelemetry/api`（未註冊 provider 時一律是 no-op）。
- 通用 OTLP（http/protobuf），span 屬性採用 OTel GenAI semantic conventions（`gen_ai.*`）。本機開發用 Langfuse。
- v1 只送 traces，不送 metrics；token 與延遲由 backend 從 span 推算。

### 1.2 啟用與設定

```json
"telemetry": { "enabled": true, "captureContent": false },
"langfuse":  { "baseUrl": "http://localhost:3000", "publicKeyEnv": "LANGFUSE_PUBLIC_KEY", "secretKeyEnv": "LANGFUSE_SECRET_KEY" }
```

| 條件 | 結果 |
|---|---|
| `OTEL_SDK_DISABLED=true` | 關閉，其他設定都不看 |
| `telemetry.enabled` 為 `true` / `false` | 依設定 |
| 沒有設定 `enabled` | 有 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 就啟用 |

Endpoint：標準的 `OTEL_EXPORTER_OTLP_*` 環境變數優先；沒有時若有 `langfuse` 區塊與金鑰，推導出 `<baseUrl>/api/public/otel/v1/traces` 與 Basic auth；兩者都沒有就用 OTel 預設（`http://localhost:4318`）。金鑰只從環境變數讀取。

### 1.3 Span 樹

```
x-plan extract | x-plan clarify            root；xplan.run.id、xplan.stage、session.id、links
 ├─ extract.prepare                        掃描、轉檔、裝箱
 ├─ invoke_agent facts-bin1                gen_ai.operation.name=invoke_agent、gen_ai.agent.name=<label>
 │   ├─ chat <model>                       每次 LLM 回應：usage、finish reason；開始時間 = 結束 − durationMs
 │   ├─ execute_tool submit_facts          被拒時 status=ERROR；check 在這個 span 內執行
 │   └─ …
 ├─ extract.merge
 ├─ invoke_agent analysis
 └─ clarify.round (xplan.round=n)
     ├─ invoke_agent clarify-rN
     │   └─ execute_tool submit_round
     │       └─ invoke_agent clarify-rN-review1   Grounding Review 在 check 裡執行，自然掛在 tool span 下
     ├─ invoke_agent clarify-rN-consistency
     └─ clarify.await_user                 xplan.await_user=true，延遲統計可以排除
```

- 每次執行程序是一條 trace。續跑的 Clarify 以 span link 指回這個 Run 之前的 trace；新的 Clarify 以 span link 指向上游 Extract Run 的 trace。
- `captureContent: true` 時才送內容：`gen_ai.system_instructions`、`gen_ai.input.messages`、`gen_ai.output.messages`（含 CoT）、`gen_ai.tool.call.arguments` / `result`、使用者的回答。預設只有 metadata。
- `run.json` 記錄 `telemetry.traces[]`：`{ traceId, rootSpanId, startedAt, spans: { <task label>: <spanId> } }`。Clarify 每次續跑追加一筆。

### 1.4 結束與中斷

`BatchSpanProcessor`；正常結束、例外時 `shutdown()`，最多等 5 秒。啟用時另外接管 SIGINT：仍開著的 span 標上 `xplan.interrupted=true`、status ERROR 後結束，flush，然後以 130 結束。匯出失敗只印一次警告，exit code 不變。

## 2. Provenance

Extract 寫出 `run.json` 的 `provenance`：Brief 中每個最終 id 的來源 task label。

```json
"provenance": {
  "ACT-1": { "text": "facts-bin1", "evidence": ["facts-bin1", "facts-bin2"], "mergedBy": ["dedup"] },
  "OQ-7":  { "text": "analysis", "evidence": ["analysis"] }
}
```

- `text`：保留下來的文字出自哪個 task。合併時（exact-name dedup 或 Analysis 的 merges）保留的是 keep 那條的文字。
- `evidence`：所有貢獻過 evidence 的 task。
- 推導邏輯放在 `extract/provenance.ts`，緊鄰 merge 與 analysis；feedback 只查表，不重建合併規則。不依賴 OTel。

## 3. Feedback

### 3.1 定位

Feedback 不是 Stage，也不是 Run，是**人貼在某個 Run 上的附註**，因此寫入那個 Run 的目錄不違反 ADR 0010。本機的 `feedback.jsonl` 是正本，Langfuse 只是鏡像（[ADR 0014](../adr/0014-feedback-is-local-first.md)）。

### 3.2 儲存

- `feedback.jsonl`：只追加。每筆有 `id`（FB-n）、`createdAt`、`author`、`target`、`verdict` 或 `score`、`note`、`snapshot`（條目當下的原文）、`at`、`trace`、`supersedes` 或 `retracts`。
- `feedback-sync.json`：同步狀態（FB id → Langfuse score id、同步時間、刪除時間），可重建。
- `author`：`XPLAN_AUTHOR` → `git config user.name` → 作業系統使用者名稱。

### 3.3 對象與 verdict

| 對象 | verdict | 說明 |
|---|---|---|
| 事實（ACT FEAT BR AC NFR ENT TERM DEP CON OOS） | `ok` / `wrong` / `partial` | 負面 verdict 必填 |
| OQ | `ok` / `redundant` / `wrong` | 同上 |
| CTR、ASM | `ok` / `wrong` | 同上 |
| missing | — | 必填，內容就是漏掉的事實；`--at file:line` 選填 |
| run | 分數 1–5 | 選填 |

v1：Extract Run 支援上表全部；Clarify Run 只支援 run 與 missing。`failed` 的 Run 也可評價，會印出提醒。

### 3.4 Supersede

同一位 author 對同一個條目（或 run 分數）再評價一次，自動以 `supersedes` 取代前一筆，並印出「FB-4 取代 FB-1」。missing 不會自動取代（每筆是不同的事實）；不同 author 的評價並存。`--retract FB-n` 撤回。

### 3.5 對應到 span

| 對象 | 掛在 |
|---|---|
| 條目 | `provenance[id].text` 的 span；其他 evidence 來源寫進 comment |
| missing 加 `--at` | `run.json` 的 `bins` 中，包含該行的 segment 所屬的 bin（跳過 `context`；重疊時取第一個，其餘寫進 comment） |
| missing 沒有 `--at`、run 分數 | 整條 trace（Clarify 用最近一條） |

### 3.6 CLI

```sh
x-plan feedback <run> ACT-3 --wrong "物流商是外部系統"
x-plan feedback <run> ACT-3 --ok
x-plan feedback <run> OQ-5 --redundant "prd.md:42 有寫"
x-plan feedback <run> --missing "VIP 免運" --at prd.md:57
x-plan feedback <run> --score 4 --note "整體不錯，但漏了運費規則"
x-plan feedback <run> --retract FB-3
x-plan feedback <run> --list
x-plan feedback <run> --sync
```

### 3.7 同步到 Langfuse

- 每次寫入後，有 Langfuse 設定與金鑰就自動同步；失敗只印警告。`--sync` 補送所有未同步的，並刪除已被取代或撤回的。
- 沒有 trace（Run 當時沒有啟用 OTel）的評價不送出，`--list` 標示「no trace」。
- Score id 由 Run id 與 FB id 決定，重送是冪等的。條目用 categorical `item-verdict`，missing 用 categorical `missing`，總分用 numeric `run-score`。
- 走 REST API（`POST /api/public/scores`、`DELETE /api/public/scores/{id}`），以 `fetch` 實作，放在可替換的 `ScoreSink` 介面後面。

## 4. 測試步驟

### 4.1 自動測試

```sh
pnpm test        # 不需要 API key、網路或 Docker
pnpm typecheck
```

| 測試檔 | 涵蓋 |
|---|---|
| `test/provenance.test.ts` | 單一 bin、exact-name dedup、Analysis merge、Analysis 新增的條目各自的來源 |
| `test/telemetry-setup.test.ts` | 啟用條件與 endpoint 推導、span 巢狀、shutdown 後可重新註冊、中斷、匯出失敗只警告一次 |
| `test/telemetry-off.test.ts` | 關閉時完全不載入 SDK 與 exporter |
| `test/telemetry-agent.test.ts` | `invoke_agent` / `chat` / `execute_tool` 的結構與屬性、預設不含內容、`captureContent`、check 內的 agent 掛在 tool span 下 |
| `test/extract.e2e.test.ts`、`test/clarify.e2e.test.ts`（with telemetry） | Stage 的 span 樹、`run.json` 的 `telemetry` 與 `provenance`、`await_user`、續跑的 span link |
| `test/feedback.test.ts` | verdict 規則、supersede、retract、`--at` 對應 bin、Clarify Run 的限制、參數解析 |
| `test/feedback-sync.test.ts` | score 的內容、增量同步與刪除、失敗後續傳、未 trace 的評價留在本機、Langfuse API 呼叫 |
| `test/config-example.test.ts` | 範例 config 合法，照抄後 tracing 是關閉的 |

### 4.2 啟動本機 Langfuse

前置：Docker Desktop 的 engine 已啟動（`docker info --format "{{.ServerVersion}}"` 印得出版本號）。

```sh
git clone https://github.com/langfuse/langfuse.git ~/langfuse
cd ~/langfuse
```

在 `~/langfuse/.env` 寫入以下內容。第一次啟動時會自動建好帳號、專案與 API key，不需要進 UI 設定。這些帳密只用於本機開發。

```
LANGFUSE_INIT_ORG_ID=xplan-org
LANGFUSE_INIT_ORG_NAME=x-plan local
LANGFUSE_INIT_PROJECT_ID=xplan-local
LANGFUSE_INIT_PROJECT_NAME=x-plan local
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-xplan-local
LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-xplan-local
LANGFUSE_INIT_USER_EMAIL=dev@example.com
LANGFUSE_INIT_USER_NAME=dev
LANGFUSE_INIT_USER_PASSWORD=xplan-local-dev
```

```sh
docker compose up -d
docker compose logs -f langfuse-web     # 出現 Ready 後 Ctrl+C
```

打開 http://localhost:3000，以 `dev@example.com` / `xplan-local-dev` 登入，進入專案「x-plan local」。

### 4.3 設定 x-plan

`x-plan.config.json`（從範例複製，填好 provider）：

```json
"telemetry": { "enabled": true, "captureContent": false },
"langfuse": { "baseUrl": "http://localhost:3000", "publicKeyEnv": "LANGFUSE_PUBLIC_KEY", "secretKeyEnv": "LANGFUSE_SECRET_KEY" }
```

```powershell
# PowerShell
$env:XPLAN_API_KEY = "..."
$env:LANGFUSE_PUBLIC_KEY = "pk-lf-xplan-local"
$env:LANGFUSE_SECRET_KEY = "sk-lf-xplan-local"
```

```sh
# bash
export XPLAN_API_KEY=... LANGFUSE_PUBLIC_KEY=pk-lf-xplan-local LANGFUSE_SECRET_KEY=sk-lf-xplan-local
```

### 4.4 實機檢查清單

每一項都寫出操作與預期結果。Langfuse 介面中的位置：**Tracing**（trace 列表與 span 樹）、**Sessions**（同一個 Run 的所有 trace）、trace 頁的 **Scores**。

**A. 連線**

| 操作 | 預期 |
|---|---|
| `pnpm smoke` | 輸出開頭有 `Tracing to http://localhost:3000/api/public/otel/v1/traces`，最後有 `Trace sent: <id>`；Langfuse 出現 `x-plan smoke` trace，底下有 `chat <model>` 與 `execute_tool submit_answer` |

**B. Extract**

| 操作 | 預期 |
|---|---|
| `pnpm dev extract <目錄>` | Langfuse 出現 `x-plan extract` trace，Session 是這個 Run 的 id |
| 展開 trace | root 底下依序是 `extract.prepare`、每個 bin 的 `invoke_agent facts-bin<k>`、`extract.merge`、`invoke_agent analysis` |
| 展開 `invoke_agent facts-bin1` | 每次模型回應各一個 `chat <model>`（generation，有 input/output token 數），每次交卷各一個 `execute_tool submit_facts`；被退回的那次是錯誤狀態 |
| 看 `invoke_agent` 的屬性 | `xplan.outcome`、`xplan.submit_attempts`、`xplan.usage.*` |
| 打開 Run 目錄的 `run.json` | 有 `telemetry.traces[0]`（traceId 與 Langfuse 上的一致，`spans` 列出每個 task）和 `provenance` |
| 檔案 trace | `traces/*.jsonl`、`*.md` 照常寫出，內容與未啟用時相同 |

**C. 內容是否外送**

| 操作 | 預期 |
|---|---|
| `captureContent: false` 跑一次 Extract | span 上沒有 prompt、CoT、tool 參數；被退回的 `execute_tool` 的錯誤訊息只寫 `submission rejected` |
| 改成 `true` 再跑一次 | `invoke_agent` 有 `gen_ai.system_instructions`、`gen_ai.input.messages`；`chat` 有 `gen_ai.output.messages`（含 reasoning）；`execute_tool` 有參數與結果 |
| 同上，看 Langfuse 的 Input / Output 欄位 | 記下 Langfuse 是否把 `gen_ai.*` 內容顯示在 Input / Output。沒有顯示的話，是 Langfuse 對 GenAI 屬性的對應問題，需要另外決定是否加上 Langfuse 專屬屬性 |

**D. Clarify**

| 操作 | 預期 |
|---|---|
| `pnpm dev clarify <extract-run-id>`，回答幾題後 `/done` | `x-plan clarify` trace，有一條 span link 指向 Extract 的 trace（`xplan.link=upstream`） |
| 展開 trace | 每個 Round 一個 `clarify.round`，裡面有 `invoke_agent clarify-r<n>`、`clarify-r<n>-consistency`；Grounding Review 的 `invoke_agent clarify-r<n>-review<k>` 掛在 `execute_tool submit_round` 底下 |
| 看 `clarify.await_user` | `xplan.await_user=true`，事件列出每則輸入的題號與種類；`captureContent: false` 時沒有回答原文 |
| 回答到一半關掉終端機，再以 Clarify Run id 續跑 | 同一個 Session 下出現第二條 trace，有 `xplan.link=resumes` 指向第一條；`run.json` 的 `telemetry.traces` 有兩筆 |
| 模型思考時按 Ctrl+C | 程序以 130 結束；Langfuse 上仍開著的 span 標有 `xplan.interrupted=true` |

**E. Feedback**

以 B 的 Extract Run 為對象，`<run>` 是它的 id。

| 操作 | 預期 |
|---|---|
| `pnpm dev feedback <run> BR-1 --wrong "以 7 天為準"` | 印出 `Recorded FB-1` 與 `Langfuse: sent FB-1`；trace 的 Scores 出現 `item-verdict = wrong`，掛在產出 BR-1 的 `invoke_agent facts-bin<k>` 上 |
| 對一個由多個 bin 合併的條目下 verdict（查 `run.json` 的 `provenance`，`evidence` 有兩個以上） | score 掛在 `text` 那個 bin，comment 有 `Also from: …` |
| `pnpm dev feedback <run> --missing "VIP 免運" --at prd.md:57` | `missing` score 掛在讀取 prd.md 第 57 行的 bin |
| `pnpm dev feedback <run> --score 4 --note "不錯"` | trace 層級的 `run-score = 4`（不掛在 span 上） |
| 再下一次 `pnpm dev feedback <run> BR-1 --ok` | 印出 `replacing FB-1`；Langfuse 上 FB-1 的 score 被刪除，換成 `ok` |
| `pnpm dev feedback <run> --retract FB-2` | 那筆 missing score 從 Langfuse 消失 |
| `pnpm dev feedback <run> --list` | 只列出仍有效的評價，狀態為 `synced` |
| 查看 `feedback.jsonl` | 每個操作都是新的一行，舊的行沒有被修改 |

**F. 失敗情境**

| 操作 | 預期 |
|---|---|
| `docker compose stop langfuse-web` 後跑 Extract | Run 正常完成，只印一次 `warning: could not export spans …` |
| 同上，記錄一筆 feedback | 寫入本機並印警告；`--list` 顯示 `not synced`；重新啟動 Langfuse 後 `--sync` 送出 |
| 不設 `LANGFUSE_SECRET_KEY` 跑 Extract | `warning: tracing is off: … LANGFUSE_SECRET_KEY is not set`，Run 正常完成 |
| 設 `OTEL_SDK_DISABLED=true` 跑 Extract | 沒有 trace，`run.json` 沒有 `telemetry` |
| `telemetry.enabled: false` 時評價那個 Run | 寫入本機，`--list` 顯示 `no trace`，不會送出 |

### 4.5 清理

```sh
cd ~/langfuse
docker compose down       # 停止，保留資料
docker compose down -v    # 停止並刪除所有資料
```

### 4.6 狀態

自動測試全部通過。4.4 的實機檢查尚未執行：開發時本機的 Docker engine 沒有啟動，也沒有可用的模型 API key。Feedback 送出的 score 內容與認證，已經用一個假的 HTTP server 跑過實際的 CLI 確認。

## 5. Commit 順序

1. `feat(extract): record item provenance in run.json`
2. `feat(telemetry): opt-in OTLP tracer, config and shutdown`
3. `feat(telemetry): spans for submit tasks, turns and tool calls`
4. `feat(telemetry): stage, round and await_user spans; span ids in run.json`
5. `feat(feedback): append-only store and CLI`
6. `feat(feedback): Langfuse score sync`
7. `docs: Feedback term, ADR 0013/0014, README`

## 6. v2（這次不做）

- 評價 Rejected Item（「不該被排除」）與 Clarify 的條目（Decision 是否忠實、題目品質、建議答案品質）。
- `x-plan feedback export`：把 feedback 轉成 `eval/cases/<name>/expected.yaml` 草稿（`wrong` → `unexpected`、missing → `facts`、`redundant` → `shouldNotBeRaised`），關鍵字仍由人挑選。
- OTel metrics（`gen_ai.client.token.usage` 等），需要另一個 metrics backend。
