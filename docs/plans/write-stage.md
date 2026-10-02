# Write Stage 實作計畫

Write 是 x-plan 的第三個 Stage：讀取 Clarify 產出的 Aligned Brief（`02-aligned.json`），寫出 Gherkin 需求文件，作為 PM、R&D、QA 討論的共同基礎。過程中不與使用者互動。名詞定義見 [CONTEXT.md](../../CONTEXT.md)。

## 1. Stage 架構

### 1.1 核心原則

- **只讀 Aligned Brief**。`x-plan write <clarify-run>` 開一個新的 Write Run，產出寫在自己的目錄，用 `03-` 前綴（[ADR 0010](../adr/0010-stage-runs-form-a-tree.md)）。讀事實前一律先查 `supersededBy`（[ADR 0008](../adr/0008-aligned-brief-adds-decisions.md)）。
- **不與使用者互動**。拷問是 Clarify 的職責；Write 發現的缺口寫成 `@open` 的 Scenario 骨架，要補就回 Clarify。
- **Agent 只判斷，資料由程式改**（[ADR 0003](../adr/0003-two-pass-extract-with-analysis-ops.md)）。每個 agent 透過 submit 工具交出結構化資料（[ADR 0002](../adr/0002-structured-output-via-submit-tool.md)），Gherkin 文字由程式決定性地渲染；SCN、FEAT-N 的 id 由程式編號，用語替換也由程式逐字執行。
- **先決定寫什麼，再寫怎麼寫**（[ADR 0015](../adr/0015-write-outline-then-feature-writers.md)）。Outline agent 看全貌、決定 Scenario 的集合；每個 Feature 的 writer 只寫 steps。
- **應該寫成行為的條目不會無聲消失**。覆蓋規則由程式檢查（[ADR 0016](../adr/0016-coverage-checked-by-code.md)）。
- **可以推導，不能編造**。Derived Scenario 一律標 `@derived`，規則沒給的值只能寫成佔位（[ADR 0017](../adr/0017-derived-scenarios-and-placeholders.md)）。
- **每個 Scenario 都能追溯**。Scenario 層級用 tag（`@SCN-3 @BR-2 @DEC-1`），step 層級與 Examples 列的出處記在 `03-trace.json`。

### 1.2 流程

```
讀取 02-aligned.json，計算有效視圖（effective view）與覆蓋集合      # coverage.ts，純函式
outline  = runSubmitTask(submit_outline)                            # 程式檢查 §1.5，共用 3 次交卷額度
applyOutline → 編號 SCN-n、FEAT-N1…                                 # 存 03-outline.json
parallel(每個 Feature, concurrency):
  writer = runSubmitTask(submit_feature)                            # 交卷檢查 = 程式檢查 §1.7 → Scenario Review §1.8
vocabulary = runSubmitTask(submit_vocabulary)                       # §1.9；失敗只寫 warning
applyReplacements → render .feature / 03-spec.md / 03-trace.json   # 渲染後以 @cucumber/gherkin 解析，失敗即程式錯誤
```

- 上游 Clarify Run 的 status 是 `failed` 時拒絕執行，除非加 `--allow-failed-clarify`。`termination` 是 `done` 或 `cap`（還有未決題目）時照常執行，印出警告並寫入 `run.json` 的 warnings。
- Outline 失敗時整個 Run 失敗。
- 某個 Feature 的 writer 失敗（reviewer 本身出錯、交卷額度用完仍不合 schema）時，其他 Feature 照常寫出；失敗的 Feature 產生只有 outline 標題的 `.feature`，Scenario 全部標 `@unwritten`。Run 的 status 為 `failed`，`run.json` 列出失敗的 Feature。
- `x-plan write <write-run> --only FEAT-3` 在同一個 Run 中補寫指定的 Feature：沿用原本的 outline 與 SCN id，writer 的 prompt 帶入既有的 Vocabulary，補寫完只對該 Feature 再跑一次 Vocabulary Normalization（沿用既有詞條，可以追加）。`run.json` 記錄每個 Feature 是哪一次寫的。

### 1.3 有效視圖與覆蓋集合

程式從 Aligned Brief 算出以下集合，outline 與 writer 的 prompt、檢查都以此為準：

```
superseded    = supersededBy 的 key
cancelled     = featureIds 全部被推翻的 BR、featureId 被推翻的 AC（隨 Feature 一起取消）
activeDec     = status 為 active 的 Decision
features      = Brief 的 FEAT − superseded
mustCover     = features ∪ AC ∪ BR ∪ { d ∈ activeDec | d.effect ≠ confirm }  − superseded − cancelled
forbidden     = superseded ∪ cancelled ∪ 未被 confirm 的 ASM ∪ 非 active 的 DEC
citable       = Brief 的事實 ∪ ASM ∪ activeDec  − forbidden          （OQ、CTR 等題目不能當 sourceIds，只能放在 agendaIds）
notBehavioralAllowed = { d ∈ activeDec | d.effect = new，或 d.effect = replace 且只推翻 FEAT、BR、AC、ASM 以外的條目 }
```

- **隨 Feature 取消**：使用者取消整個 Feature 時，只屬於它的 BR 與 AC 也一起取消，不再要求覆蓋，也不得引用；同時屬於其他 Feature 的 BR 保留。
- **notBehavioralAllowed 包含推翻非行為條目的 replace**：例如推翻 TERM 定義的 Decision，effect 是 `replace`，但沒有行為可寫。推翻 FEAT、BR、AC、ASM 的 replace，以及調和矛盾的 `reconcile`，一律不能標。
- **被用到的名稱帶有行為**：推翻 Term、Actor、Domain Entity、Dependency 的 Decision，只有在被推翻條目的名稱（Term 含 aliases）沒有出現在任何 mustCover 條目的文字中（FEAT 的名稱、描述、輸入、輸出，BR 的規則與條件，AC 的文字與 given／when／then，其他 Decision 的結論）時，才能標 `notBehavioral`。出現了就表示它改變了那些條目的行為，例如「鑑賞期」從 3 天改成 7 天，會改變「鑑賞期內可無條件退貨」的期限，所以必須被 Scenario 引用，writer 才拿得到新的定義。比對方式是不分大小寫的子字串比對，寧可多要求引用。被擋下的 Decision 與出現的位置記錄在 `notBehavioralBlocked`，退回訊息據此說明原因。
- forbidden 的每個條目都記錄原因（被哪條 Decision 推翻、隨哪個 Feature 取消、未確認的 Assumption、被哪條 Decision 更正），退回訊息據此告訴 agent 應改引用什麼。

- 被 confirm 的 ASM 可以當成一般事實引用；DEC 的 effect 為 `confirm` 時，引用它或它確認的 ASM 都可以，不強制。
- 被推翻的 FEAT 不產生 `.feature`，列在 `03-spec.md` 的「已取消的 Feature」，附上推翻它的 Decision 與使用者原話。

### 1.4 `submit_outline`

```jsonc
{
  "features": [{
    "featureId": "FEAT-1",                 // Brief 的 FEAT；新 Feature 不填，改填 newFeature
    "newFeature": { "name": "…", "description": "…", "sourceIds": ["DEC-9"] },
    "rules": [{
      "sourceId": "DEC-1",                 // BR，或推翻它的 active Decision
      "title": "…",
      "scenarios": [Scenario]
    }],
    "scenarios": [Scenario]                // 不屬於任何 Rule 的 Scenario
  }],
  "notBehavioral": [{ "id": "DEC-4", "reason": "名詞定義，併入用語表" }]
}

Scenario = {
  "title": "…",
  "kind": "specified" | "derived" | "open" | "deferred",
  "sourceIds": ["AC-4", "DEC-1"],
  "agendaIds": ["OQ-3"],                   // open / deferred：對應的 Agenda Item
  "openReason": "…"                        // open 但沒有對應的 Agenda Item 時必填，例如「缺少驗收條件」
}
```

- Rule 底下的 Scenario，程式會把 Rule 的 `sourceId` 併入它的有效 sourceIds。
- `specified`：內容來自 AC、BR、Decision 明說的部分。`derived`：見 ADR 0017。`open`：對應 status 為 `unresolved` 的題目，或缺少行為資訊的 FEAT。`deferred`：對應 status 為 `deferred` 的題目。
- Tag 由程式推導：`@nfr` 來自 sourceIds 中的 NFR，`@open`、`@deferred`、`@derived` 來自 `kind`。

### 1.5 Outline 的程式檢查

1. 每個 `features` 中的 FEAT 都在 Brief 中、沒有被推翻，且只出現一次；每個 `features` 集合中的 FEAT 都有一個區塊，且至少有一個 Scenario（FEAT 的覆蓋）。
2. `newFeature.sourceIds` 至少含一條 `notBehavioralAllowed` 中的 Decision（effect 為 `new` 的 active Decision）。
3. **覆蓋**：`mustCover − 已覆蓋 = ∅`；已覆蓋 = 所有 Scenario 的有效 sourceIds ∪ `notBehavioral` 的 id ∪ 有 Scenario 的 FEAT 區塊。
4. **禁止引用**：所有 sourceIds、Rule 的 `sourceId` 都必須在 `citable` 中。退回訊息依原因說明：被推翻的條目應改引用哪條 Decision、被更正的 Decision 應改引用哪條、未確認的 Assumption 不得引用、OQ 等題目要放在 `agendaIds`。`specified`、`derived` 的 Scenario 的有效 sourceIds 不得為空。
5. 每條 AC 至少被一個 `kind` 為 `specified` 的 Scenario 引用（被推翻的 AC 不在此限）。
6. `notBehavioral` 的 id 必須在 `notBehavioralAllowed` 中，`reason` 不得為空。BR、AC、FEAT 一律不能標。
7. `open`、`deferred` 的 `agendaIds` 必須指向 status 分別為 `unresolved`、`deferred` 的 Agenda Item；`deferred` 至少要有一個，`open` 沒有 `agendaIds` 時 `openReason` 必填。`specified`、`derived` 的 Scenario 不得有 `agendaIds`。
8. 引用 NFR 的 Scenario：該 NFR 必須有 `target`，或 sourceIds 中另有 active Decision；否則退回（沒有門檻的 NFR 不寫成 Scenario）。
9. Rule 的 `sourceId` 是 BR 或 active Decision，同一個 Feature 內不重複。
10. 語言檢查（ADR 0005）：標題、`newFeature` 的名稱與描述、`reason`、`openReason`。

有錯誤的部分連同它包含的內容一起排除：區塊有錯（規則 1、2）排除整個區塊，Rule 有錯（規則 4、9）排除該 Rule 與底下的 Scenario，Scenario 有錯（規則 4、7、8）只排除該 Scenario，`notBehavioral` 有錯（規則 6）只排除該筆。覆蓋（規則 3、5）以排除後剩下的部分計算，所以被排除的 Scenario 原本覆蓋的條目會變成沒有覆蓋。語言不符（規則 10）只是警告，照常收下。

最後一次交卷時部分接受：被排除的部分移入 `03-rejected.json`，其餘照常收下；沒有被覆蓋的條目寫進 `03-spec.md` 的「未覆蓋」清單與 `run.json` 的 warnings。

`applyOutline` 依 Feature、Rule 的順序編號 `SCN-n`，新 Feature 編號 `FEAT-N1`、`FEAT-N2`，結果存成 `03-outline.json`。

### 1.6 `submit_feature`（writer）

```jsonc
{
  "description": "…",                     // Feature 描述
  "background": [Step],                   // 可省略
  "scenarios": [{
    "id": "SCN-3",                        // 必須剛好是本 Feature 在 outline 中的 SCN
    "openReason": "…",                    // 可省略；填了就表示從 specified / derived 降為 open
    "steps": [Step],
    "examples": [{                        // 有 Examples 即為 Scenario Outline
      "name": "需求明定",
      "derived": false,
      "header": ["等級", "天數", "結果"],
      "rows": [{ "cells": ["一般", "7", "接受"], "sourceIds": ["DEC-1"] }]
    }]
  }]
}

Step = { "keyword": "Given" | "When" | "Then" | "And" | "But", "text": "…", "sourceIds": ["…"], "dataTable": [["…"]] }
```

- 標題、種類、Scenario 的集合都由 outline 決定，writer 不能新增、刪除或改標題。
- writer 看不到整份 Aligned Brief，只看到 outline 中本 Feature 的片段，以及程式依片段中的 sourceIds 查出的條目內容（§2）。需要一條 outline 沒給的條目時，表示 outline 有缺漏：writer 把該 Scenario 降為 `open` 並寫明理由，不自行補上。
- `open`、`deferred` 的 Scenario 只寫已知的 steps；最後一行佔位的 Then 由程式依題目原文產生，例如 `Then <待決 OQ-3：已出貨的訂單能否退貨？>`。
- Scenario Outline 只用於「steps 相同、只差在數值」的情況。原文或 Decision 給的例子與 `@derived` 的例子分成不同的 Examples 區塊，因為 tag 只能掛在 Examples 區塊上。
- Step 用宣告式的業務語言，主詞用 Actor 的原名，名詞用 Term、Domain Entity 的原名；不寫 UI 操作細節，除非原文就是在描述 UI。

### 1.7 Writer 的程式檢查

1. `scenarios` 的 id 集合剛好等於本 Feature 在 outline 中的 SCN。
2. **允許清單**：每個 step、每個 Examples 列的 sourceIds 只能是該 Scenario 在 outline 中的有效 sourceIds，加上 `<context>` 中的條目與本 Feature 的 FEAT。forbidden 的條目不會出現在 writer 的輸入中，這條規則同時涵蓋了禁止引用。
3. Scenario Outline：每個 header 欄位都要出現在 steps 的 `<欄位>` 中；每列的格數等於欄數。`kind` 為 `derived` 的 Scenario，所有 Examples 區塊都必須是 `derived`。
4. **數值出處**：不是 `derived` 的內容中，steps 與 Examples 的阿拉伯數字（先把全形數字與一到九十九的中文數字正規化）必須出現在它引用的條目文字中（事實的欄位與 Evidence 引文、Decision 的結論與使用者原話）。`<…>` 佔位內的文字不檢查。
5. `openReason` 只能填在 outline 中為 `specified`、`derived` 的 Scenario 上。
6. **Then**：`specified`、`derived` 的 Scenario 至少要有一個 Then；`open`、`deferred`（包括 writer 降級的）不得有 Then，最後一行由程式產生。
7. 語言檢查（ADR 0005）：描述、Background、step、Examples 名稱與 cells。Term、Actor、Entity、Dependency 的原名、`<…>` 佔位內容與引號（「」、『』、""、“”）中的原文值先移除再檢查。

Background 的 sourceIds 可以引用本 Feature 任何一個 Scenario 的有效 sourceIds 加上 `<context>`；它的數值也檢查。

最後一次交卷時部分接受：
- 違反規則 1（不在 outline 中、重複）、2、3 的 Scenario 移入 `03-rejected.json`。規則 3 不通過的表格渲染出來不是合法的 Gherkin，所以不能保留。Background 違反規則 2 時整個 Background 移入 `03-rejected.json`。
- 違反規則 4、5、6 的照常收下並標 `@unverified`，原因記在 Scenario 上；規則 5 的 `openReason` 不予採用。Background 違反規則 4 時照常收下，原因記在 Feature 上。
- 語言不符的照常收下並寫入警告。
- outline 中有、但最後沒有被收下的 Scenario（沒寫或被排除）渲染為 `@unwritten`。

### 1.8 Scenario Review

程式檢查通過後，在同一次交卷檢查中（`SubmitTool.check`，非同步）呼叫 reviewer，比照 [ADR 0011](../adr/0011-grounding-review-before-decisions-are-written.md)（[ADR 0018](../adr/0018-scenario-review.md)）。

- reviewer 每次只看本 Feature 的 Scenario，每個附上它引用的條目全文：事實附 Evidence 引文，Decision 附結論與使用者原話。它看不到其他條目，沒有別的材料可以當依據。
- reviewer 逐句（step、Examples 列）標註：根據是哪些條目、是不是由引用的條目**必然推得**、有沒有和引用的條目相反、出現的具體數值出自哪個條目。
- 判定由程式從回報推出：

| 判定 | 意思 | writer 要做的事 |
|---|---|---|
| `unsupported` | 寫了引用的條目沒說的內容 | 刪掉沒有根據的部分 |
| `contradicts` | 和引用的條目相反 | 改正 |
| `invented-value` | 具體數值沒有出處 | 改成 `<…>` 佔位 |
| `underived` | 標 `@derived` 但推不出來 | 刪掉推不出的部分，或降為 `open` |
| `misattributed` | 內容其實來自別的條目 | 改正 sourceIds |

- 被標記的 Scenario 以 tool result 退回 writer，與程式檢查共用 3 次交卷額度。重交 3 次後仍被標記的，照樣寫進 `.feature`，標 `@unverified`，reviewer 的意見寫在 `03-trace.json` 並列在 `03-spec.md`。
- reviewer 本身失敗時，該 Feature 的 writer 失敗（§1.2），不會跳過檢查。
- thinking 預設比 writer 低一級（xhigh、high 降為 medium，medium 降為 low），可用 `stages.write.review.thinking` 調整。

### 1.9 Vocabulary Normalization

全部 Feature 的 writer 都完成後跑一次（[ADR 0019](../adr/0019-vocabulary-normalization.md)）。

```jsonc
{
  "entries": [{
    "canonical": "會員",
    "definition": "…",
    "avoid": ["使用者", "用戶"],
    "sourceIds": ["ACT-1"]
  }],
  "replacements": [{ "loc": "SCN-3/step/2", "from": "使用者", "to": "會員" }]
}
```

- `loc` 由程式在 user message 中為每一段文字標出：`FEAT-1/description`、`FEAT-1/rule/1`、`SCN-3/title`、`SCN-3/step/2`、`SCN-3/background/1`、`SCN-3/examples/1/row/2/cell/1` 等。
- 標準用語的優先順序：Brief 的 Term、Actor、Domain Entity 原名 → 使用者在 Decision 中的用詞 → steps 中最常出現的說法。不能新創一個所有來源都沒出現過的說法。這條只寫在 prompt。
- 程式逐字套用替換，只在指定的 `loc` 內、跳過 `<…>` 佔位與引號中的原文值；`from` 找不到時跳過並記成 warning，不退回。除了 schema 驗證與語言檢查（`definition`）之外，不做程式檢查。
- 替換後的文字不再經過 Scenario Review，替換紀錄完整保存在 `03-vocabulary.json`。
- 失敗時只寫 warning，以 writer 的原始文字渲染，Run 的 status 不受影響。
- `stages.write.vocabulary.enabled` 預設為 `true`；thinking 預設比 writer 低一級，可用 `stages.write.vocabulary.thinking` 調整。

### 1.10 渲染

`.feature` 的格式：

```gherkin
@FEAT-1
Feature: 會員申請退貨
  （Feature 描述）

  Background:
    Given …

  Rule: 一般會員 7 天、VIP 10 天內可退貨

    @SCN-3 @DEC-1 @AC-4
    Scenario Outline: 會員在到貨後第 <天數> 天申請退貨
      Given 會員等級為 <等級>
      And 商品到貨已 <天數> 天
      When 會員申請退貨
      Then 系統<結果>退貨申請

      Examples: 需求明定
        | 等級 | 天數 | 結果 |
        | 一般 | 7    | 接受 |
        | VIP  | 10   | 接受 |

      @derived
      Examples: 邊界
        | 等級 | 天數 | 結果 |
        | 一般 | 8    | 拒絕 |
        | VIP  | 11   | 拒絕 |

  @SCN-5 @open @OQ-3 @FEAT-1
  Scenario: 已出貨未到貨的訂單申請退貨
    Given 訂單已出貨但尚未到貨
    When 會員申請退貨
    Then <待決 OQ-3：已出貨的訂單能否退貨？>
```

- 關鍵字一律用英文（`Feature`、`Rule`、`Scenario`、`Given`…），內容用輸出語言；不加 `# language:`。
- Tag 順序：`@SCN-n`、種類（`@derived`、`@open`、`@deferred`、`@unverified`、`@unwritten`、`@nfr`）、Agenda Item id、sourceIds。
- Clarify 新增的 Feature 檔名為 `FEAT-N1.feature`，Feature 層級加上它的 Decision tag，描述註明「此功能來自 Clarify 的決定，需求文件中沒有對應段落」。
- 佔位的 Then 依語言產生：`@open` 為 `<open OQ-3: …>`、`<待決 OQ-3：…>`、`<待决 OQ-3：…>`；`@deferred` 為 `<deferred OQ-1: …>`、`<延後 OQ-1：…>`、`<延后 OQ-1：…>`。對應多個題目時，第二行起用 `And`；沒有對應題目的 open 寫成 `<待決：openReason>`。
- `@unwritten` 的 Scenario 只有 tag 與標題，沒有 steps。
- 文字中會被 Gherkin 當成語法的部分一律處理掉：標題與 step 的換行改成空白；表格的 `\`、`|`、換行跳脫；Feature 描述中以 `@`、`#`、`|`、`"""` 或 `Scenario:` 等關鍵字開頭的行，前面加上 `· `。
- 表格依顯示寬度對齊（中日韓文字算兩格）。
- 渲染結果一律以 `@cucumber/gherkin` 解析；解析失敗代表渲染程式有錯，Run 直接失敗。

`03-spec.md` 的內容（標題沿用 `02-aligned.md` 的慣例用英文；被推翻的事實標出取代它的 Decision）：

1. 目錄：每個 `.feature` 檔、Scenario 數、`@open`／`@deferred`／`@unverified`／`@derived` 的數量
2. Actor、Domain Entity（屬性、狀態、關聯）
3. NFR（沒有寫成 Scenario 的也列出）、Constraint、Dependency
4. 不做清單（Out-of-Scope Item）
5. 已取消的 Feature、Clarify 新增的 Feature
6. 用語表：連到 `03-vocabulary.md`
7. 未寫成 Scenario 的條目（`notBehavioral` 與理由）
8. 未覆蓋的條目（outline 最後一次交卷仍沒覆蓋的）
9. 未決總表：`@open`、`@deferred` 的 Scenario，以及和任何 Feature 都無關的 unresolved、deferred 題目
10. `@unverified` 的 Scenario 與 reviewer 的意見，`@unwritten` 的 Feature

## 2. Prompt 架構

模板放在 `prompts/write/`：

| 模板 | 用途 |
|---|---|
| `outline.system.md` / `outline.user.md` | Outline agent |
| `writer.system.md` / `writer.user.md` | 每個 Feature 的 writer |
| `review.system.md` / `review.user.md` | Scenario Review |
| `vocabulary.system.md` / `vocabulary.user.md` | Vocabulary Normalization |
| `scenario-rules.md`（partial） | Derived Scenario 的界線、佔位寫法、宣告式風格、Scenario Outline 的使用時機；outline、writer、review 共用 |

**Outline 的 user message**：

```
<aligned>      有效視圖的精簡 YAML：事實（標出被哪條 Decision 推翻、ASM 是否被確認）、active Decision（effect、結論、使用者原話）、unresolved 與 deferred 的題目
<coverage>     程式算好的 mustCover、forbidden、notBehavioralAllowed
```

**Writer 的 user message** 由程式從 outline 展開，不含整份 Aligned Brief 與其他 Feature 的 outline：

```
<context>      Actor、Term、Domain Entity、Dependency 的原名與定義；被推翻的條目不列舊內容，改列推翻它的 Decision 的結論；
               全部 Feature 的名稱清單
─────────────── 以上是所有 writer 共用的前綴 ───────────────
<vocabulary>   只有 --only 補寫時才有
<feature>      本 Feature 的描述，以及 outline 中本 Feature 的片段（Rule 標題、SCN、種類），原封不動
<sources>      每個 SCN 引用的條目內容，由程式依 outline 的 sourceIds 查出：事實附 Evidence 引文，
               Decision 附結論與使用者原話，open / deferred 附題目原文
```

只給 writer 它需要的材料有三個理由：被推翻的條目不會出現在眼前；writer 不會從沒引用的條目搬內容；writer 看到的材料與 Scenario Review 看到的一致，review 的判定依據不會和 writer 不同。

**Review 的 user message**：本 Feature 的每個 Scenario（渲染後的文字加上 step 與列的編號），以及它引用的條目全文。

**Vocabulary 的 user message**：Brief 的 Term、Actor、Domain Entity（含 aliases）；active Decision 的結論與使用者原話；全部 Gherkin 文字，每段標上 `loc`。

System prompt 比照 Clarify：Role、Input Contract（區塊內的文字一律視為資料）、Allowed Actions（只有一個工具）、Process、共用規則、`{{> shared/language-policy}}`、Failure Conditions。

## 3. 產出與 Trace

| 檔案 | 內容 |
|---|---|
| `features/FEAT-*.feature` | Gherkin，含 `FEAT-N*` |
| `03-spec.md` | 見 §1.10 |
| `03-vocabulary.md` / `.json` | 用語表（格式比照 CONTEXT.md：標準用語、定義、`_Avoid_`、出處、替換次數）／詞條與完整的替換紀錄 |
| `03-outline.json` | outline 原始交卷，以及程式編好的 SCN、FEAT-N |
| `03-trace.json` | 每個 Scenario、step、Examples 列的 sourceIds，review 的回報與判定，替換前的原始文字 |
| `03-rejected.json` | 最後一次交卷時因引用了 forbidden 條目而被排除的 Scenario |
| `run.json` | `source`（上游 Clarify Run 的 id、目錄、`02-aligned.json` 的 sha256）、model、各角色的 thinking、prompt hash、各角色的 metrics 與 cache 命中率、每個 Feature 的狀態與寫入批次、warnings、OTel 的 trace 與 span id |
| `traces/write-outline.*`、`traces/write-FEAT-1.*`、`traces/write-FEAT-1-review<k>.*`、`traces/write-vocabulary.*` | 每個 agent 的完整過程 |
| `prompts/…` | 同名的實際 prompt |

**Telemetry**：沿用既有的 span 結構，Run → `write.outline`、`write.feature`（每個 Feature 一個，底下是 writer 的交卷與 review）→ `write.vocabulary`。

**Feedback**：`x-plan feedback <write-run> SCN-3 --wrong "…"`，verdict 為 `--ok`、`--wrong`、`--partial`；`--missing` 記錄漏寫的情境；`--score` 對整個 Run 評分。快照取自 `03-trace.json` 中渲染後的 Scenario，span 是該 Feature writer 的 session。

## 4. 檔案結構

```
src/write/
  schema.ts          submit_outline / submit_feature / submit_review / submit_vocabulary、WriteOutline、WriteRun
  coverage.ts        有效視圖、mustCover、forbidden、notBehavioralAllowed（純函式）
  outline.ts         §1.5 的檢查、applyOutline（編號）
  writer.ts          §1.7 的檢查、數值正規化
  review.ts          reviewer 呼叫、判定推導
  vocabulary.ts      替換的套用與紀錄
  render.ts          .feature、03-spec.md、03-vocabulary.md、03-trace.json；@cucumber/gherkin 解析
  prompts.ts         各角色的 prompt 建置、有效視圖的 YAML 渲染
  stage.ts           runWrite、--only
src/eval/write/      expected schema、score
prompts/write/       見 §2
eval/cases/<name>/write/   aligned.json（fixture）、expected.yaml
```

CLI：

```
x-plan write <clarify-run> [--out <dir>] [--allow-failed-clarify] [--lang <code>] [--config <path>]
x-plan write <write-run> --only <FEAT-id...> [--config <path>]
```

Config：

```jsonc
"stages": {
  "write": {
    "thinking": "high",
    "review": { "thinking": "medium" },
    "vocabulary": { "enabled": true, "thinking": "medium" }
  }
}
```

writer 的並行數沿用 `concurrency`。輸出語言繼承自上游；用 `--lang` 覆寫時，若與上游不一致會寫入 warning。交卷額度與 nudge 次數沿用 3 次和 2 次。

新增依賴：`@cucumber/gherkin`、`@cucumber/messages`（渲染結果的解析驗證）。

## 5. 評估策略

用法為 `pnpm eval --stage write [--cases …] [--repeat N]`，只跑有 `write/` 子目錄的案例。

- **輸入**：每個案例放一份固定、經人工審過的 `write/aligned.json`，不串接前面的 Stage。第一個案例用 returns，以現有的 Clarify fixture 與 `answers.yaml` 跑一次 Clarify，人工審過後存成 fixture。
- **標註** `write/expected.yaml`：

```yaml
mustHaveScenarios:
  - { id: vip-window, all: ["VIP", "10"], sourceIds: [DEC-1] }      # 某個 Scenario 含全部關鍵字，且引用其中任一 id
  - { id: day-8-rejected, all: ["8", "拒絕"], derived: true }
shouldNotAppear:
  - { id: old-window, any: ["3 天"], reason: "BR-2 已被 DEC-1 推翻" } # 出現在任何 step 或 cell 都算錯
expectedOpen: [OQ-1]                                               # 應以 @open 或 @deferred 呈現的題目
vocabulary:
  - canonical: 會員
    variants: [使用者, 用戶, 客戶]
distinct:
  - [會員, 管理者]
```

- **指標**：

| 指標 | 定義 |
|---|---|
| 必要情境召回率 | `mustHaveScenarios` 命中的比例 |
| 被推翻內容出現數 | `shouldNotAppear` 命中的次數 |
| 未決呈現率 | `expectedOpen` 以 `@open`、`@deferred` 呈現的比例 |
| 覆蓋退回數 | outline 因 §1.5 規則 3、4、5 被退回的次數 |
| Review 攔下數 | 依判定分類的次數；`@unverified` 數 |
| 結構 | `@derived` 比例、`notBehavioral` 數、FEAT-N 數、只引用 FEAT 本身的 Scenario 數（Clarify gherkin-gap 召回的反向指標）、writer 因 outline 缺漏而降為 `open` 的數量 |
| 用語一致性 | `variants` 在 steps 中出現的次數，統一前（writer 原始文字）與統一後各算一次 |
| 錯誤合併 | `distinct` 中的詞被替換成彼此的次數 |
| 意思偏移 | 統一前後的必要情境召回率、被推翻內容出現數的差異 |
| 替換 | 替換總數、跳過的替換數、詞條數 |
| 合法性 | 渲染結果全部通過 `@cucumber/gherkin` 解析 |
| 成本 | tokens、cache 命中率、重試次數、語言警告 |

用語統一可以用 `stages.write.vocabulary.enabled: false` 對照，主要用來量測成本與確認其他指標的差異。

## 6. 測試策略

依 TDD 進行，從純函式開始往外做。

1. **單元測試（純函式，表格驅動）**：
   - coverage：supersededBy、confirm 的 ASM、revised 的 Decision、effect 的各種組合。
   - outline：§1.5 每一條規則都有 red 和 green 兩種案例，另外包含最後一次交卷的部分接受、SCN 與 FEAT-N 的編號。
   - writer：§1.7 每一條規則，數值正規化（全形、中文數字、佔位內不檢查）。
   - review：回報到判定的推導。
   - vocabulary：只在 `loc` 內替換、跳過佔位與引號、`from` 找不到時的 warning。
   - render：`.feature` 的 golden 檔、每個 golden 都能被 `@cucumber/gherkin` 解析；`03-spec.md`、`03-trace.json`。
2. **Prompt 測試**：snapshot；**前綴穩定性測試**：不同 Feature 的 writer prompt 在 `<context>` 結尾之前完全相同；`<sources>` 只含該 Feature 的 SCN 引用的條目，不含任何 forbidden 條目。
3. **端到端測試**：`ScriptedBackend` 依工具名稱選擇腳本，以 returns 的 fixture 執行：
   - 正常流程
   - Review 退回一次後通過
   - Review 用完額度 → `@unverified`
   - 某個 Feature 的 writer 失敗 → `@unwritten`、status `failed`，再以 `--only` 補寫
   - outline 最後一次交卷部分接受 → 未覆蓋清單
   - 上游沒收斂 → 警告；上游 failed → 拒絕，`--allow-failed-clarify` 放行
   - Vocabulary 失敗 → 警告，以原始文字渲染
4. **Eval 計分的單元測試**：用手寫的 Write Run fixture 驗證每一項指標。

## 7. 實作順序

每一步單獨成一個 commit，而且 `pnpm test` 和 `pnpm typecheck` 都要通過。

1. 文件：本計畫、CONTEXT.md 新增 Outline、Coverage、Derived Scenario、Scenario Review、Vocabulary Normalization、Vocabulary；新增 ADR 0015–0019。
2. `schema.ts`、`coverage.ts`，連同單元測試。
3. `outline.ts`，連同單元測試。
4. `writer.ts`，連同單元測試。
5. `render.ts`，加入 `@cucumber/gherkin`，連同 golden 測試。
6. `review.ts`、`vocabulary.ts`，連同單元測試。
7. prompt 模板與 `prompts.ts`，連同 snapshot 測試與前綴穩定性測試。
8. `stage.ts`，連同端到端測試。
9. CLI、`--only`、config、README，並手動 smoke。
10. Feedback 支援 Write Run（SCN 的 verdict）。
11. write eval：returns 的 fixture、`expected.yaml`、score、報告。

## 8. 待議事項

- **數值正規化的範圍**：§1.7 規則 4 只處理阿拉伯數字、全形數字與一到九十九的中文數字。單位換算（「一週」對「7 天」）會造成誤退回，先以 eval 的覆蓋退回數與重試次數觀察。
- **跨 Feature 的 step 用語**：目前靠 Vocabulary Normalization 統一名詞，不統一句型。之後要接 Cucumber 的 step definition 時再考慮。
- **Step 層級的 Feedback**：目前只到 SCN。
- **串接 eval**：`--chain`，從 Extract 一路跑到 Write，量測整條流程。
