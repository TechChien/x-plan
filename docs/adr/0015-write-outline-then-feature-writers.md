# Write 先由 Outline 決定寫什麼，再由每個 Feature 的 writer 寫 steps

Write 分兩段。第一段由單一的 Outline agent 讀取整份 Aligned Brief，交出每個 Feature 底下有哪些 Rule、哪些 Scenario，每個 Scenario 只有標題、種類（`specified`、`derived`、`open`、`deferred`）和它引用的條目，不含 steps。程式檢查覆蓋規則（ADR 0016）並編號 `SCN-n` 之後，第二段由每個 Feature 一個 writer 平行寫出 steps 與 Examples。所有交卷都是結構化資料，Gherkin 文字由程式決定性地渲染，渲染結果以 `@cucumber/gherkin` 解析驗證。

「要寫哪些情境」需要看全貌：判斷每條規則與 Decision 是否都有情境承接、沒掛在任何 Feature 上的條目要放哪裡、兩個 Feature 有沒有寫到同一件事，都只有看得到全部條目的一方才能做。「怎麼寫 steps」則是局部的工作。分開之後，outline 的輸出很小，覆蓋檢查在 writer 動工前就能做完，退回的成本低；writer 的輸出切成每個 Feature 一份，交卷被退回時只重寫一個 Feature。這和 Extract 的 Facts／Analysis（ADR 0003）是同一個想法：判斷由看得到全貌的一方做，資料由程式改。

## Consequences

- Scenario 的集合、標題、種類由 outline 決定，writer 不能新增、刪除或改標題，只能把某個 Scenario 從 `specified`、`derived` 降為 `open` 並附理由（寫不出來時不硬寫）。
- outline 可以新增 Brief 裡沒有的 Feature，但 `sourceIds` 必須含一條 effect 為 `new` 的 active Decision，id 由程式編為 `FEAT-N1`、`FEAT-N2`。這讓 Clarify 問出的新能力不必硬塞進不相干的 Feature，又保證每個新 Feature 都追溯到使用者的原話（ADR 0007）。
- 被推翻的 FEAT 不產生 `.feature`，列在 `03-spec.md` 的「已取消的 Feature」。
- writer 看不到整份 Aligned Brief。它的輸入由程式從 outline 展開：本 Feature 的 outline 片段，加上依片段中的 sourceIds 查出的條目內容；另外有一段所有 writer 共用的 `<context>`（Actor、Term、Domain Entity 的原名與定義），可以共用 prefix cache。被推翻的條目不會出現在 writer 眼前，writer 也無法從沒引用的條目搬內容。條目也不附 Evidence 引文：引文可能帶著被推翻的內容（Feature 的證據常常就是寫著舊規則的那一句），writer 照引文寫出舊值時，數值檢查與 Scenario Review 都會因為「引用的條目有說」而放行。step 的 sourceIds 只能引用該 Scenario 的 sourceIds 與 `<context>` 中的條目；需要 outline 沒給的條目時，writer 把 Scenario 降為 `open`，不自行補上。
- Write 不與使用者互動。寫的時候發現的缺口寫成 `@open` 的 Scenario 骨架，要補就回 Clarify。上游 Clarify 因 `/done` 或達到 Round 上限而結束時照常執行，未決題目本來就是 Write 的正常輸入（ADR 0008），只印出警告。
- outline 失敗時整個 Run 失敗；某個 Feature 的 writer 失敗時，其他 Feature 照常寫出，失敗的 Feature 標 `@unwritten`，可以用 `x-plan write <write-run> --only FEAT-3` 在同一個 Run 中補寫，沿用原本的 outline 與 SCN id。

## Considered Options

- **單一 agent 一次寫完全部 Feature**：最簡單，但大型需求的輸出很長，交卷被退回時整份重來，覆蓋檢查也要等全部 steps 寫完才能做。不採用。
- **每個 Feature 一個 writer，由程式依 `featureIds`、`relatedIds` 分配條目**：沒掛在任何 Feature 上的 BR 與 Decision 無法由程式決定歸屬，跨 Feature 的重複也沒有人看得到。不採用。
- **模型直接交出 Gherkin 文字，程式解析驗證**：寫法比較靈活，但 step 無法掛上出處，id 與 tag 也要靠模型寫對。不採用。
