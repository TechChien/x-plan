# x-plan

把需求文件轉換成 BDD（Gherkin）需求文件，讓 PM、R&D、QA 有共同的討論基礎。流程分三個 Stage：**Extract → Clarify → Write**。名詞定義見 [CONTEXT.md](CONTEXT.md)，架構決策見 [docs/adr/](docs/adr/)。

目前已實作 **Stage 1：Extract** 與 **Stage 2：Clarify**，另外可以用 OpenTelemetry 追蹤執行過程，並以 `x-plan feedback` 評價產出。

## 安裝與設定

需要 Node ≥ 22.19 和 pnpm。

```sh
pnpm install
cp x-plan.config.example.json x-plan.config.json   # 填入 LiteLLM 的 baseUrl 與 model id
export XPLAN_API_KEY=...                            # API key 只從環境變數讀取
pnpm smoke                                          # 驗證 tool calling、reasoning effort、CoT 是否正常
```

## 使用

```sh
pnpm dev extract <目錄>              # 或建置後使用 x-plan extract <目錄>
pnpm dev extract <目錄> --dry-run    # 只做掃描、轉檔、裝箱並渲染 prompt，不呼叫模型
```

參數：`--include <glob...>`、`--exclude <glob...>`、`--reference <glob...>`、`--lang <en|zh|cn>`、`--out <dir>`、`--config <path>`。

### 輸出語言

Brief 一律以英文輸出，與來源文件的語言無關。要改用中文，在 config 設定 `"outputLanguage"`，或用 `--lang` 覆寫（CLI 優先於 config）：

| 代碼 | 語言 |
|---|---|
| `en` | 英文（預設） |
| `zh` | 繁體中文 |
| `cn` | 簡體中文 |

引用原文、識別名稱（資料表、欄位、端點、檔名）和 glossary 的 `term` / `aliases` 保留原文，其餘一律使用輸出語言。交卷時由程式檢查語言：`en` 不得出現中日文字；`zh` 不得出現簡體專用字，`cn` 不得出現繁體專用字，而且長段的敘述欄位不得是英文。不符合就回饋重交；最後一次仍不符合時保留條目並寫入警告，不會被排除。設計理由見 [ADR 0005](docs/adr/0005-output-language-enforced-by-code.md)。

### 參考資料（Reference Document）

需求文件常附帶資料庫 schema、API 手冊這類參考資料。直接混在一起讀，模型會把參考資料的整份內容都當成需求擷取。把它們放進指定目錄下的 `references/` 子目錄即可：

```
spec/
├── req.md                 # 需求文件
└── references/            # 底下所有文件（含子目錄）都是參考資料
    ├── api-manual.md
    └── schema/tbl_device.md
```

不方便搬移檔案時，也可以用 `--reference` 另外指定，會與 `references/` 合併：

```sh
pnpm dev extract spec/ --reference "schema/**" "api-manual.md"
```

被標記的檔案只擷取需求文件用得到的部分（用到的資料表、欄位、端點、規則），不會自己產生 Actor 或 Feature。至少要有一份未標記的需求文件。參考資料太多、分成多批時，每一批都會附上需求文件供判斷相關性；需求文件本身超過預算的一半時無法附上，執行時會出現警告。設計理由見 [ADR 0004](docs/adr/0004-reference-documents.md)。

每個 Stage 的每一次執行都是一個獨立的 Run，放在 `./.x-plan/runs/<run-id>/`，id 以 Stage 開頭（例如 `extract-20260930-1530-a1b2c3`）。每個 Run 的 `run.json` 都記錄它讀取的上游：同一個 Extract Run 可以開出多個 Clarify Run，彼此互不影響（[ADR 0010](docs/adr/0010-stage-runs-form-a-tree.md)）。

```
.x-plan/runs/
  extract-…-a1b2c3/     ← x-plan extract spec/
  clarify-…-d4e5f6/     ← x-plan clarify extract-…-a1b2c3
  clarify-…-0718ab/     ← x-plan clarify extract-…-a1b2c3（同一個 Extract，另一次 Clarify）
```

Extract Run 的產出：

| 檔案 | 內容 |
|---|---|
| `01-brief.json` | Requirement Brief，也就是交給下一個 Stage 的正式契約 |
| `01-brief.md` | 給人閱讀的 Brief，包含出處、被排除的條目、來源對照 |
| `01-rejected.json` | 未通過驗證的 Rejected Item |
| `run.json` | 輸入檔 hash、model、prompt hash、裝箱結果、各 agent 的指標、id 對照表、每個條目來自哪個 agent（`provenance`）、啟用 OTel 時的 trace 與 span id |
| `sources/*.txt` | 轉檔後的文字；Evidence 的行號以這份文字為準 |
| `prompts/*.md` | 實際送給模型的 system prompt 和 user message |
| `traces/*.jsonl` / `*.md` | 每個 agent 的完整過程，包含 CoT、tool call、驗證錯誤與重試 |

### Clarify：拷問到需求對齊

指定要從哪一個 Extract Run 開始，Clarify 會開一個新的 Clarify Run；指定 Clarify Run 則是續跑它。參數可以是 run id（到 `.x-plan/runs/` 找）或目錄：

```sh
pnpm dev clarify extract-20260930-1530-a1b2c3   # 從這個 Extract Run 開一個新的 Clarify Run
pnpm dev clarify clarify-20260930-1600-d4e5f6   # 續跑這個 Clarify Run
```

Clarify 只讀取上游的 `01-brief.json`，不會寫入 Extract Run 的目錄。上游必須是 `succeeded`；Extract 失敗時仍會寫出 Brief，但要加 `--allow-failed-extract` 才能使用。開始時會印出這次 Clarify 讀的是哪個 Extract Run、Brief 的 sha，方便確認沒有指錯。

Clarify 以多個 Round 進行。每一 Round，模型會先解讀你上一輪的回答，整理成 Decision，再提出下一批問題（預設一次 5 題）。問題來自 Brief 的 Open Question、Contradiction、Assumption，也包括模型根據你的回答提出的追問，以及為了寫出 Gherkin 而發現的缺口。每題都附有建議答案，可以直接採用：

| 輸入 | 意思 |
|---|---|
| 自由文字 | 用自己的話回答 |
| `/ok` | 採用建議答案 |
| `/1` … `/4` | 選擇選項 |
| `/later` | 晚點再問；同一題第二次會轉為延後 |
| `/defer [原因]` | 延後到會後決定，Write 會標成 `@deferred` |
| `/na [原因]` | 不適用 |
| `/note [ID] 內容` | 主動補充或更正，例如 `/note DEC-2 VIP 是 10 天` |
| `/done` | 結束提問；已回答的會先整理成 Decision，其餘標為未決 |

模型不會替你回答：每一條 Decision 都必須對應到你的一則回答，模型也不能自行判定某題不適用或已有答案（[ADR 0007](docs/adr/0007-decisions-grounded-in-user-answers.md)）。Decision 寫入前還會經過 Grounding Review：由另一個 agent 檢查 Decision 有沒有寫進你沒說的內容、你的回答有沒有答完整、有沒有答非所問，有問題就退回重寫或改成追問你（[ADR 0011](docs/adr/0011-grounding-review-before-decisions-are-written.md)）。每一 Round 寫入 Decision 之後，再由 Consistency Check 比對新的 Decision 與先前的 Decision、Brief 事實；發現不能同時成立的組合，就在下一批的最前面問你以哪一邊為準，題目上方會列出兩邊的原文（[ADR 0012](docs/adr/0012-consistency-check-puts-conflicts-to-the-user.md)）。這兩個檢查角色的 thinking 預設比 Clarify 低（Clarify 為 xhigh 或 high 時用 medium，medium 時用 low），可用 config 的 `stages.clarify.review.thinking`、`stages.clarify.consistency.thinking` 調整。每則回答輸入後就立即存檔。中斷後，以 Clarify Run 的 id 重跑就會從中斷的地方接續；上游的 Brief 如果在這之間被改寫過，會拒絕續跑，要改用 `--restart` 從頭開始。

參數：`--out <dir>`（新 Clarify Run 的目錄）、`--restart`、`--allow-failed-extract`、`--lang <en|zh|cn>`（預設沿用 Brief 的語言）、`--max-rounds <n>`（預設 8）、`--batch-size <n>`（預設 5）、`--config <path>`。

Clarify Run 的產出：

| 檔案 | 內容 |
|---|---|
| `02-aligned.json` | Aligned Brief：原樣的 Brief 加上 Decision 與每個題目的最終狀態，並記錄來源 Extract Run，是交給 Write 的正式契約（[ADR 0008](docs/adr/0008-aligned-brief-adds-decisions.md)） |
| `02-aligned.md` | 給人閱讀的版本：Decision、被推翻的條目、還沒決定的題目 |
| `02-transcript.md` | 完整的問答紀錄 |
| `02-state.json` | 續跑用的狀態；回答只會追加、不會修改 |
| `02-rejected.json` | 最後一次交卷仍未通過驗證的 Decision 或問題 |
| `run.json` | 上游 Extract Run 的 id 與 Brief 的 sha、model、prompt hash、每一 Round 的指標（含 prefix cache 命中率）、結束原因 |
| `traces/clarify-r<n>.*`、`prompts/clarify-r<n>.*` | 每一 Round 的 agent 過程與實際送出的 prompt；`clarify-r<n>-review<k>.*` 是該 Round 第 k 次 Grounding Review，`clarify-r<n>-consistency.*` 是該 Round 的 Consistency Check |

題目的排序目前採暫定規則（矛盾 → 依嚴重度排序的問題 → 假設），放在可替換的獨立 module，見 [ADR 0009](docs/adr/0009-question-ordering-is-a-separate-module.md)。

## 可觀測性（OpenTelemetry）

每個 Run 都會在 `traces/` 寫出完整的檔案 trace。另外也可以把過程以 OpenTelemetry span 送到 Langfuse 或任何 OTLP backend，在 UI 中瀏覽 Run → Round → agent → 每次模型回應與交卷的樹狀結構（[ADR 0013](docs/adr/0013-opentelemetry-supplements-file-traces.md)）。

預設關閉。以下任一條件成立就啟用：

- config 設定 `"telemetry": { "enabled": true }`
- 環境中有標準的 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（`OTEL_EXPORTER_OTLP_HEADERS` 等標準變數照常適用）

`OTEL_SDK_DISABLED=true` 一律關閉，`"enabled": false` 優先於環境變數。

[x-plan.config.example.json](x-plan.config.example.json) 附有這兩個區塊，tracing 預設關閉：

```json
"telemetry": { "enabled": false, "captureContent": false },
"langfuse": {
  "baseUrl": "http://localhost:3000",
  "publicKeyEnv": "LANGFUSE_PUBLIC_KEY",
  "secretKeyEnv": "LANGFUSE_SECRET_KEY"
}
```

| 設定 | 意思 |
|---|---|
| `telemetry.enabled` | `true` 開啟、`false` 關閉（連環境變數也擋掉）；整行拿掉時，由 `OTEL_EXPORTER_OTLP_*` 環境變數決定 |
| `telemetry.captureContent` | 是否連 prompt、CoT、tool 參數、Clarify 的回答一起送（見下方） |
| `langfuse.baseUrl` | Langfuse 的位址：沒有 OTLP endpoint 變數時，trace 送到這裡；Feedback 也同步到這裡 |
| `langfuse.publicKeyEnv` / `secretKeyEnv` | 存放金鑰的**環境變數名稱**；金鑰本身只從環境變數讀取 |

送到 Langfuse：把 `enabled` 改成 `true`，再設定金鑰：

```sh
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
```

沒有設定 OTLP endpoint 變數時，endpoint 與認證會從 `langfuse` 區塊推導出來。改送其他 OTLP backend 時，設定 `OTEL_EXPORTER_OTLP_ENDPOINT`（環境變數優先於 `langfuse` 區塊）。不使用 Langfuse 就刪掉 `langfuse` 區塊；保留它但沒設金鑰時，每次記錄 Feedback 都會出現「未同步」的警告。

- **預設不送內容**：span 只帶 token、時間、狀態、id、重試次數。要連 prompt、CoT、tool 參數與 Clarify 的回答一起送，設定 `"captureContent": true`。需求文件若屬機密，請先確認 backend 的存取權限。
- 每次執行程序是一條 trace，以 Run id 作為 session 串起來；續跑的 Clarify 與上游 Extract 以 span link 連接。
- `clarify.await_user` 是等你回答的時間，標有 `xplan.await_user=true`，看延遲時可以排除。
- Backend 連不上只會印一次警告，不影響 Run。程式結束或按 Ctrl+C 時會先 flush，最多等 5 秒。
- `pnpm smoke` 在啟用時也會送出一條 trace，可用來確認設定。

在本機啟動 Langfuse（需要 Docker）：

```sh
git clone https://github.com/langfuse/langfuse.git && cd langfuse
docker compose up -d          # 啟動後打開 http://localhost:3000，建立專案並取得 API key
```

## Feedback：評價 Run 的產出

`x-plan feedback` 記錄你對某個 Run 產出的評價。評價存在那個 Run 的目錄下的 `feedback.jsonl`；有設定 Langfuse 時，也會以 score 的形式同步過去，掛在產出該條目的 span 上（[ADR 0014](docs/adr/0014-feedback-is-local-first.md)）。

```sh
x-plan feedback <run> ACT-3 --wrong "物流商是外部系統，不是內部角色"
x-plan feedback <run> ACT-3 --ok
x-plan feedback <run> OQ-5 --redundant "prd.md 第 42 行有寫"
x-plan feedback <run> --missing "VIP 免運" --at prd.md:57
x-plan feedback <run> --score 4 --note "整體不錯，但漏了運費規則"
x-plan feedback <run> --retract FB-3
x-plan feedback <run> --list
x-plan feedback <run> --sync
```

`<run>` 可以是 run id 或目錄。可以下的 verdict 依條目種類而定：

| 條目 | verdict |
|---|---|
| 事實（ACT、FEAT、BR、AC、NFR、ENT、TERM、DEP、CON、OOS） | `--ok`、`--wrong`、`--partial` |
| Open Question | `--ok`、`--redundant`（文件已有答案）、`--wrong`（問錯方向） |
| Contradiction、Assumption | `--ok`、`--wrong` |

`--ok` 以外的 verdict 都要附上說明。`--missing` 記錄應該擷取卻沒擷取的事實，`--at` 指出它在 Source Document 的位置；`--score` 是對整個 Run 的 1–5 分。Clarify Run 目前只支援 `--score` 與 `--missing`。

- **只追加，不修改**。同一個人對同一條目再評價一次，會取代前一筆；`--retract` 撤回。不同人的評價並存。作者依序取自 `XPLAN_AUTHOR`、`git config user.name`、作業系統的使用者名稱。
- 每筆評價都保存條目當下的原文，Brief 之後重跑也不影響。
- 每次記錄後會自動同步到 Langfuse，失敗只印警告；`--sync` 補送尚未送出的評價，並刪除已被取代或撤回的。Run 當時沒有啟用 OTel 時，評價只留在本機，`--list` 標示為 `no trace`。

## 調整 prompt

Prompt 都是 [prompts/](prompts/) 底下的 Markdown 模板：

- `{{name}}` 是變數，必須在 front-matter 的 `variables` 中宣告，只替換一輪，而且採嚴格模式。
- `{{> shared/...}}` 會原封不動地引入共用片段。

如果不想修改內建模板，可以在 config 設定 `promptsDir`，把要改的檔案放在那個目錄下，沒有覆寫的檔案會自動使用內建版本。每次執行時，`run.json` 都會記錄所用模板的 hash。

改完模板後：

1. 執行 `pnpm test`，snapshot 會顯示 prompt 的差異。
2. 確認差異就是你要的改動後，執行 `pnpm test -u` 更新 snapshot。

## 評估（Live eval）

對真實模型跑 [eval/cases/](eval/cases/) 裡的案例，並依人工標註的 `expected.yaml` 計分：

```sh
XPLAN_API_KEY=... pnpm eval                                   # 全部案例各跑 1 次
XPLAN_API_KEY=... pnpm eval --cases glossary-split --repeat 5  # 指定案例、重複 5 次
```

報告寫在 `eval/results/<時間>/report.md`，內容包含：
- 召回率、矛盾偵測率、真問題提出率、多餘問題數、雜訊命中率、重複假設數、條目數、Rejected 數、重試次數、token 用量
- 每次執行的明細：未擷取的事實、未提出的真問題、多餘的問題、命中的雜訊
- 報告會記錄 prompt 的 hash，方便比較不同版本的 prompt

每個案例是一個目錄，內含 `docs/` 和 `expected.yaml`。條目用關鍵字比對，不用 id（id 是模型產生的）。`packing: per-file` 會強制每個檔案各自一批；`language` 指定輸出語言（預設 `en`），標註的關鍵字要用同一種語言；參考資料放在 `docs/references/`，或用 `reference` 列出 glob；`openQuestions.mustBeRaised` 列出文件確實沒回答、Brief 必須提出的問題，`openQuestions.shouldNotBeRaised` 列出文件其實已回答、提出就是多餘的問題；`assumptions.shouldNotDuplicate` 列出推測答案不該被寫成 Assumption 的問題（關鍵字只比對 Assumption 的敘述，不比對理由），用來量測重複假設；`unexpected` 列出不該出現在 Brief 的內容，用來量測雜訊（召回率只看有沒有抓到，看不出抓了多少無關的東西）。

### Clarify eval

```sh
XPLAN_API_KEY=... pnpm eval --stage clarify [--cases returns] [--repeat 5]
```

只跑有 `clarify/` 子目錄的案例。Clarify 的輸入是一份固定、經人工審過的 `clarify/brief.json`，不先跑 Extract，所以分數不受 Extract 的變異影響。使用者由 `clarify/answers.yaml` 扮演（範例見 [eval/cases/returns/clarify/answers.yaml](eval/cases/returns/clarify/answers.yaml)）：

- `answers`：每個標註以 `target` 指定 Brief 的題目 id（fixture 的 id 固定），`reply` 是使用者會輸入的內容，可以用 `/ok`、`/defer` 等指令。`expectDecisions` 列出這則回答應該產生的 Decision（結論包含全部關鍵字；`supersedes` 的每組關鍵字要對到一條被推翻的 Brief 條目；`confirms: true` 表示要確認該假設）。`ambiguous: true` 表示回答刻意模糊、應該被追問，`followUpReply` 回答問題包含任一關鍵字的追問。`goodRecommendation` 檢查第一次顯示的建議答案。
- `gaps`：應該提出的 gherkin-gap，以 `relatedIds` 比對。每個 gap 標註只回答第一題對到的題目，之後對到的一律以 `unmatchedReply` 回答，避免同一句回答被套到每一題相關的 gap。
- `conflicts`：使用者後來的回答會與先前的 Decision 衝突時，標出衝突（`any` 關鍵字）與衝突題的回答 `reply`。衝突題的題目包含任一關鍵字，或 interpreter 自行 revise 了結論包含關鍵字的 Decision，都算處理到。沒有對到標註的衝突題計為多餘衝突題。
- `unmatchedReply`：沒有對到任何標註的題目一律這樣回答（預設 `/na`），並計為雜訊題。

報告的指標：解讀正確率、錯誤推翻數、追問召回與多餘追問、gap 召回、雜訊題數、建議答案命中率、自行作答攔截數（agent 試圖在沒有回答時做出 Decision 而被退回的次數）、Review 攔下數（Grounding Review 依多加內容／只答一部分／答非所問退回的 Decision 數）、衝突處理率與多餘衝突題數、Round 數與結束原因、交卷次數、prefix cache 命中率、token 用量。每次執行的 run 目錄另有 `eval-answers.json`，記錄每一題是由哪個標註回答的。

## 開發

```sh
pnpm test        # 單元測試，外加用 scripted agent 跑的端到端測試
pnpm typecheck
pnpm build
```
