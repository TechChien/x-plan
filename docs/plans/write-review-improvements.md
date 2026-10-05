# Write 改進計畫：write-20261002-1617-3e77a4 評估後續

來源：對 cpe-inventory 案例 Write Run `write-20261002-1617-3e77a4`（上游 `clarify-20261002-0920-a01020`）的人工評估。名詞定義見 [CONTEXT.md](../../CONTEXT.md)，Scenario Review 的設計見 [ADR 0018](../adr/0018-scenario-review.md)。

## Checklist

細節見各節。C1 與 D2 必須一起上線（§4.3）。

**Scenario Review（§2）**
- [x] R1 沒改過的 unit 沿用上一輪判定，不重審（stage.ts、review.ts）
- [x] R1 單元測試：沒變不重審、改一行就重審、沿用的被標記 unit 仍退回
- [x] R2 review prompt：derived 的 Then 連同 Given 一起判
- [x] R3 Given 被判 `underived` 時用 premise 訊息（review.ts）
- [x] R3 單元測試：Given 用 premise 訊息，Then 用原訊息

**Coverage（§4）**
- [x] C1 NFR 與 confirm Decision 加入 mustCover；引用被確認的 ASM 也算覆蓋（coverage.ts）
- [x] C2 NFR 與 confirm Decision 加入 notBehavioralAllowed（coverage.ts）
- [x] C3 刪除 NFR 的 target 規則（outline.ts）
- [x] C1–C3 單元測試（write-coverage、write-outline）
- [x] write-stage.md §1.3、§1.5 第 8 條同步更新

**重複 Scenario（§5）**
- [x] D1 跨 Feature 標出 Given 與 Then 都相同的 Scenario，列在 03-spec.md 與 run.json warnings
- [x] D1 單元測試
- [x] D2 outline prompt：被引用就算覆蓋，不用另開 Scenario
- [x] D3 eval 報告加入「只靠 reconcile／confirm Decision 的 specified Scenario 數」與 D1 重複組數
- [x] §3 觀察點：eval 報告加入「前提被退回」數（review 紀錄的 finding 標 `premise`）

**收尾（§6）**
- [x] prompt 快照更新（R2、D2）
- [x] 全部測試與型別檢查通過
- [x] 以 `clarify-20261002-0920-a01020` 重跑 Write，對照 §2–§5 的預期結果（`write-20261005-0837-b233f7`：§4、§5 符合；§2 本次 review 無退回，R1／R3 未觸發，留待 §3 觀察）

## 1. 評估發現

| # | 問題 | 本計畫 |
|---|---|---|
| A | SCN-15 在修正後語意變錯，Scenario Review 沒抓到 | §2 |
| B | NFR-1 與 DEC-18（X-API-Key 驗證）沒有寫進任何 Scenario | §4 |
| C | 跨 Scenario 重複（SCN-29／36、SCN-22／43、SCN-41、SCN-30–32），約佔 1/4 篇幅 | §5 |
| D | SCN-3 照抄 DEC-3「every entry carrying a ProductHash is resolved」，與 SCN-17（DEC-14：hash 查不到的不解析）互相矛盾 | 暫不處理 |
| E | 缺 derived 案例：一筆 entry 對到多個 CPE（DEC-5）、重試成功不發 alert（DEC-11） | 暫不處理 |

## 2. Scenario Review：SCN-15 的失誤

### 2.1 經過

| 輪次 | SCN-15 的文字 | 判定 | 問題 |
|---|---|---|---|
| review1 | 有前提 `And the device data has not changed since that run` | 通過 | — |
| review2 | **與 review1 相同**（writer 這次只改了 SCN-1 的 sourceIds） | `underived` | 同一段文字翻案 |
| writer 第 3 次交卷 | 照退回訊息刪掉前提 | — | 退回訊息只說「刪掉」，沒提醒 Then 依賴這個前提 |
| review3 | 沒有前提 | 通過 | 逐行審，單看 Then 看不出它少了前提 |

最終版本的 Then「the manually triggered run reports the same data the scheduled run reports」在兩次 run 之間資料有變時不成立。DEC-4 的「same run」指的是同一個 job，不是同樣的資料。

### 2.2 改動

**R1. 沒改過的 unit 沿用上一輪的判定，不重審**（程式）

- 在 `runWriter`（[stage.ts](../../src/write/stage.ts)）中跨交卷保留 `unitKey → ScenarioReviewRecord`。`unitKey` 由 unit 的 kind、sourceIds 與每一行的 text、sourceIds 組成。
- 每次交卷只把 key 不在表中的 unit 送給 reviewer。沒改過的 unit 沿用上次的紀錄：通過的維持通過，被標記的維持被標記，並照樣退回 writer。
- `judgeReview` 合併「沿用的紀錄」與「本輪結果」；`paths` 依本次交卷重新對應。
- 效果：同一段文字不會拿到兩種判定；review 的輸入只剩改過的 Scenario（這次 review2、review3 都重審了 22 個，實際只改了 1 個）。

**R2. derived Scenario 的 Then 連同 Given 一起判**（prompt，[review.system.md](../../prompts/write/review.system.md)）

在 Process 的 `entailed` 說明後加入：

> In a `kind: derived` scenario, judge each Then together with the scenario's Given and When lines: it is `entailed` only if the cited items **and those Givens** force it. "Then the second run reports the same data as the first" follows only when a Given says the data did not change in between; without that Given it is `none`.

不改回報格式與 schema。

**R3. Given 被判 `underived` 時，退回訊息提醒 Then 可能跟著失效**（程式，[review.ts](../../src/write/review.ts) `judgeReview`）

- 被退回的行若是 Given（或 When 之前的 And／But），訊息改為：

  > does not necessarily follow from {cited}: "{text}". It is a premise: if you remove it, check that every Then still follows without it; if one does not, remove that Then too or give openReason

- 其他行沿用原訊息。行在 When 之前或之後，由 `underReview` 產生的行序判斷。

### 2.3 不做：擴充「設定情境的 Given」的正例

review2 的誤判來自 prompt 對「設定情境的 Given 是 entailed」只舉了「第 8 天」與「兩個 tenant」兩種例子。原本考慮加入「固定其他條件的 Given（資料沒變、同一台裝置）」作為正例。

不做的理由：這一項防的是 reviewer 把該保留的前提誤判成沒根據。有 R1、R3 之後，這種誤判最壞只會讓 writer 連同 Then 刪掉，或把 Scenario 改成 `@open`，文件會變得保守，但不會寫錯；代價小，不值得再加一條依賴模型類推的 prompt 規則。R2 防的是放行寫錯的內容，沒有其他機制能擋，所以保留。

## 3. 觀察點

- **被判 `underived` 的 Given 行數**：eval 的「Review 攔下數」再按行的位置（When 之前／之後）分開統計。若之後常見 derived Scenario 因前提被退回而改成 `@open` 或被刪掉 Then，表示誤判的代價變大，再回頭考慮 §2.3。
- **同一 unit 的判定翻轉數**：R1 實作後應為 0；作為 R1 的回歸檢查。
- **context 值被判無出處**（eval 的「context 值被判無出處」欄）：`invented-value` 的值若也出現在 context 條目（actors、glossary、entities、dependencies），表示 reviewer 沒看到程式視為「每一步都有」的條目而誤判。大於 0 時，把 context 條目加進 reviewer 的 `sources`（估計每次 review 多 170～700 tokens）。
- **review token 量**：R1 之後，第 2 次以後的 review 輸入應只含改過的 Scenario。
- 重複 Scenario 的觀察點見 §5.2 D3。

## 4. Coverage：NFR 與確認類 Decision 不得無聲消失

### 4.1 問題

NFR-1（以 `X-API-Key` 驗證）與 DEC-18（確認 ASM-3：一把 service-level key 給所有 tenant 共用）沒有出現在任何 Scenario，QA 從文件看不出要測驗證。上一次 Run（1422）有寫出 `@nfr` 的 SCN-49，這次沒有，結果靠運氣。原因有二：

1. **不在 mustCover**（[coverage.ts](../../src/write/coverage.ts) `mustCover`；[write-stage.md](write-stage.md) §1.3）。mustCover 只含 FEAT、BR、AC 與 effect 不是 `confirm` 的 active Decision。NFR 不在其中；ASM 未確認時禁止引用，確認後又不強制引用，它的內容兩頭落空。
2. **NFR 的 target 規則擋住可驗證的 NFR**（[write-stage.md](write-stage.md) §1.5 第 8 條）。引用 NFR 的 Scenario，該 NFR 必須有 `target` 或另引 active Decision。這條原本是要擋「系統要很快」這類沒有門檻的 NFR，但 NFR-1「要帶 header」本身就可以驗證，不需要數字門檻，也被擋住。

### 4.2 改動

**C1. NFR 與 effect 為 `confirm` 的 Decision 加入 mustCover**（程式）

- 未被推翻的 NFR 加入 mustCover。
- effect 為 `confirm` 的 active Decision 加入 mustCover；引用該 Decision，或引用它確認的 ASM，都算覆蓋。

**C2. 這兩類可以標 `notBehavioral` 並附理由**（程式）

- 加入 `notBehavioralAllowed`。例如 DEC-16「由 server 端元件執行，Admin tenant 只是資料範圍」不是行為，outline 寫一句理由即可；理由列在 `03-spec.md`「Not written as scenarios」。

**C3. 刪除 NFR 的 target 規則**（程式，[outline.ts](../../src/write/outline.ts) `nfrTargets`；同步修改 write-stage.md §1.5 第 8 條）

- 這條規則真正要防的是「沒有門檻卻寫出數字」，已由兩道檢查涵蓋：非 derived Scenario 中沒有出處的數字會被程式檢查退回，Scenario Review 也會判為 `invented-value`。
- 沒有門檻、寫不成 Scenario 的 NFR，依 C2 標 `notBehavioral`（理由例如「沒有可量測的門檻」），或寫成 `@open` Scenario。

**結果**：每一條 FEAT、BR、AC、NFR 與 active Decision，不是有 Scenario 引用，就是在 `03-spec.md` 寫明為什麼不寫。

### 4.3 與重複偵測的關係

mustCover 變多會讓 outline 傾向為新增的條目另開 Scenario，加重 §5 的重複問題；C1 必須與 §5 的 outline prompt 改動一起做。

### 4.4 驗證

- [write-coverage.test.ts](../../test/write-coverage.test.ts)：NFR 與 confirm Decision 出現在 mustCover 與 notBehavioralAllowed；引用被確認的 ASM 即算覆蓋 confirm Decision；被推翻的 NFR 不在 mustCover。
- [write-outline.test.ts](../../test/write-outline.test.ts)：沒有 target 的 NFR 可以被 Scenario 引用。
- 以 `clarify-20261002-0920-a01020` 重跑 Write：NFR-1 與 DEC-18 被某個 Scenario 引用，或列在「Not written as scenarios」並附理由。

## 5. 重複的 Scenario

### 5.1 問題

同一件事被寫成多個 Scenario，約佔本次 1/4 篇幅：

| 重複組 | 內容 | 起因 |
|---|---|---|
| SCN-29／36 | Given、Then 幾乎一字不差（DEC-23），分別放在「dcnt ≥ 1」與「保留最後數量」兩條 Rule 下 | 同一條 Decision 在兩條 Rule 下各寫一次 |
| SCN-22／43 | 都在講由 server 端元件執行（DEC-24） | reconcile Decision 另開 Scenario |
| SCN-41、42 | 重述 DEC-14、DEC-11 已寫過的內容（DEC-20） | reconcile Decision 另開 Scenario |
| SCN-30／32 | 都在講沒有結果的 tenant 不送（DEC-15、DEC-19） | reconcile Decision 另開 Scenario |

4 組中有 3 組來自 reconcile Decision：mustCover 要求它被引用且不能標 `notBehavioral`，而它的內容多半只是重申某一邊成立，outline 卻為它另開 Scenario，沒有把它的 id 加到已經在寫那件事的 Scenario。

以程式偵測的兩種做法，用本次資料測試的結果：

- **比對引用條目是否重疊**：不可行。多個 Scenario 引用同一條目、各寫不同面向是常態（例如 DEC-2 被 SCN-5、6、17 引用）。
- **比對文字是否完全相同**：只抓得到 SCN-29／36。SCN-26／27 的 Then 也相同，但 27 是 derived 的邊界案例，不是重複，所以必須連 Given 一起比。

### 5.2 改動

**D1. 程式標出 Given 與 Then 完全相同的 Scenario**（程式，[render.ts](../../src/write/render.ts)）

- 寫完所有 Feature 後，跨 Feature 比對每個 Scenario 的 Given 集合與 Then 集合（When 之前的 And／But 算 Given，之後的算 Then；比對前轉小寫、去掉反引號與引號、去頭尾空白）。兩者都相同即為重複。
- 列在 `03-spec.md` 新增的「Duplicate scenarios」段落，並寫入 `run.json` 的 warnings。只提醒，不退回：Scenario 的集合由 outline 決定，writer 沒有權限刪除 Scenario。

**D2. Outline prompt：被引用就算覆蓋，不用另開 Scenario**（prompt，[outline.system.md](../../prompts/write/outline.system.md)）

加入：

> Covering an item means citing it, not giving it a scenario of its own. A reconcile or confirm Decision that only restates what a planned scenario already shows is covered by adding its id to that scenario's `sourceIds`; give it a scenario only when it adds something no planned scenario shows.

預期效果（以本次為例）：DEC-24 與 DEC-16 加到 SCN-43，不再有 SCN-22；DEC-19 加到 SCN-30，不再有 SCN-32；DEC-20 帶有新內容（不產生報告），SCN-42 照樣保留。

限制：

- 「是否只是重申」由模型判斷。誤判成重申時，該 Decision 的 id 仍掛在某個 Scenario 上，writer 看得到全文，仍有機會寫進 steps。
- SCN-29／36 型（一般 Decision 在兩條 Rule 下各寫一次）不在這行 prompt 的範圍內，由 D1 標出。

**D3. 觀察點**

- 統計 specified Scenario 中，`effectiveSourceIds` 裡除了 FEAT 之外只剩 reconcile 或 confirm Decision 的個數，列在 eval 報告。本次有 SCN-22、SCN-43 等。D2 實作後應下降；沒有下降再考慮其他做法。
- D1 的重複組數，列在 eval 報告。

### 5.3 不採用

- **另加 Outline Review agent 找重複**：多一次呼叫，且仍靠模型判斷語意。
- **程式退回只引用 reconcile Decision 的 Scenario**：會誤殺帶有新內容的 Scenario，例如只引用 DEC-20 的 SCN-42。

### 5.4 驗證

- [write-render.test.ts](../../test/write-render.test.ts)：D1 對 Given、Then 都相同的兩個 Scenario 產生警告；只有 Then 相同（Given 不同）時不產生；跨 Feature 也能比對。
- prompt 快照：D2 更新快照。
- 以 `clarify-20261002-0920-a01020` 重跑 Write：SCN-22、SCN-32 型的 Scenario 消失或減少，D3 的計數下降，SCN-29／36 若再出現會列在「Duplicate scenarios」。

## 6. 驗證

- 單元測試（[write-review.test.ts](../../test/write-review.test.ts)）：
  - R1：第二次交卷 unit 沒變，不送 reviewer、沿用上次判定；改一行就重審；沿用的被標記 unit 仍退回 writer。
  - R3：Given 被判 `underived` 時用 premise 訊息，Then 被判時用原訊息。
- prompt 快照（`write-prompts.test.ts`）：R2 更新快照。
- eval：在 returns 案例加一個 SCN-15 型的 derived 情境（兩次結果相同，需要「中間沒有變動」的前提）。
- 回歸：以 `clarify-20261002-0920-a01020` 重跑 Write，確認 SCN-15 保留前提或改為 `@open`，review token 量下降。
