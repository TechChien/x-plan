# x-plan

把需求文件轉換成 BDD（Gherkin）需求文件，讓 PM、R&D、QA 有共同的討論基礎。流程分三個 Stage：**Extract → Clarify → Write**。名詞定義見 [CONTEXT.md](CONTEXT.md)，架構決策見 [docs/adr/](docs/adr/)。

目前已實作 **Stage 1：Extract**。

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

每次執行的產出放在 `./.x-plan/runs/<run-id>/`：

| 檔案 | 內容 |
|---|---|
| `01-brief.json` | Requirement Brief，也就是交給下一個 Stage 的正式契約 |
| `01-brief.md` | 給人閱讀的 Brief，包含出處、被排除的條目、來源對照 |
| `01-rejected.json` | 未通過驗證的 Rejected Item |
| `run.json` | 輸入檔 hash、model、prompt hash、裝箱結果、各 agent 的指標、id 對照表 |
| `sources/*.txt` | 轉檔後的文字；Evidence 的行號以這份文字為準 |
| `prompts/*.md` | 實際送給模型的 system prompt 和 user message |
| `traces/*.jsonl` / `*.md` | 每個 agent 的完整過程，包含 CoT、tool call、驗證錯誤與重試 |

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
- 召回率、矛盾偵測率、雜訊命中率、條目數、Rejected 數、重試次數、token 用量
- **resolvedQuestions 評估**：用同一次輸出比較「套用」與「不套用」的差別，統計「正確移除 / 誤刪真問題 / 待人工判斷 / 漏解 / 未被提出」
- 報告會記錄 prompt 的 hash，方便比較不同版本的 prompt

每個案例是一個目錄，內含 `docs/` 和 `expected.yaml`。條目用關鍵字比對，不用 id（id 是模型產生的）。`packing: per-file` 會強制每個檔案各自一批；`language` 指定輸出語言（預設 `en`），標註的關鍵字要用同一種語言；參考資料放在 `docs/references/`，或用 `reference` 列出 glob；`unexpected` 列出不該出現在 Brief 的內容，用來量測雜訊（召回率只看有沒有抓到，看不出抓了多少無關的東西）。

## 開發

```sh
pnpm test        # 單元測試，外加用 scripted agent 跑的端到端測試
pnpm typecheck
pnpm build
```
