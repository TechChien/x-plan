# 每一 Round 由 Consistency Check 找出 Decision 之間的衝突，再交給使用者確認

使用者回答某一題時，不一定記得自己之前在別題說過什麼。新的 Decision 可能和先前的 Decision 或 Brief 的事實互相矛盾，但 interpreter 不會發現，因為它每一輪專注於解讀當輪的 Answer。實測中出現過兩種情況：

- **後來的 Decision 自己加了例外，但沒有更正先前的 Decision。** DEC-21 寫「每次執行，每個 tenant 一定送一次」，同一輪的 DEC-23 卻寫「沒有對應 CPE 的 tenant 不送」。DEC-23 的文字裡補了一句「前一條只適用於有 CPE 的 tenant」，但 DEC-21 沒有被標成修訂。
- **先前的 Decision 沒跟上後來的範圍調整。** DEC-5 的彙整範圍只寫了軟體表，之後的 DEC-7 決定硬體也要算。

ADR 0008 規定 Aligned Brief 原樣保留每一條仍有效的 Decision。只讀到 DEC-21 的人（包括 Write）會寫出錯誤的情境。

因此每一 Round 寫入 Decision 之後，由第三個 agent 做 **Consistency Check**。這和 [ADR 0011](0011-grounding-review-before-decisions-are-written.md) 的 Grounding Review 不同：Grounding Review 檢查的是一條 Decision 和它所依據的 Answer；Consistency Check 檢查的是 Decision 之間，以及 Decision 和 Brief 之間。它只負責找出衝突，**不做裁決**。每個衝突都變成一題 `origin: conflict` 的 Follow-up Question 交給使用者，之後照一般流程由 interpreter 解讀使用者的回答。這維持了 ADR 0007 的原則：Decision 只來自使用者的回答。

## 運作方式

- **比對範圍**：只比對本輪新寫入的 Decision，對象是所有仍有效的 Decision 和 Brief 中沒被推翻的事實（Open Question、Contradiction、Assumption 都還在問，所以不算事實）。舊的組合在先前的 Round 已經比對過，不重複比對，所以成本不會隨輪數增加。
- **不算衝突的情況**：Decision 自己宣告的 `supersedes` / `revises` 是有意的取代，不算衝突；已經提出、還沒解決的衝突也不會再提一次。這些由程式檢查，不符合的提交會退回重交。
- **怎麼問**：衝突題排在下一批題目的最前面，同樣占用每批的名額。理由是衝突沒解決之前，之後的題目可能都建立在錯的前提上。終端機會在題目上方列出每一邊的原文，以及那條 Decision 是根據哪一則回答寫出的。
- **怎麼結案**：使用者回答後，衝突題的結案方式和 Contradiction 相同（規則 5）。interpreter 要 `revises` 不再成立的 Decision、`supersedes` 不再成立的事實，或者在 `relatedIds` 列出每一邊，並說明各自在什麼條件下成立。prompt 建議優先把舊的 Decision 修訂成一條完整的敘述，讓讀者不必同時看兩條。
- **連鎖上限**：解決衝突寫出的 Decision 也可能造成新的衝突。衝突題記錄自己的 `depth`，超過 `maxFollowUpDepth` 就不再提問。
- **無法提問時**：收尾輪（`/done` 或撞到輪數上限）發現的衝突，以及超過連鎖上限的衝突，直接標成 unresolved，留在 Aligned Brief 的「Not decided」，並標出衝突的兩邊。
- **記錄方式**：衝突記錄在該 Round 的 `conflicts`，replay 時照樣重建。

## Consequences

- 每一輪有新 Decision 時，多一次 LLM 呼叫。thinking 的預設值和 Grounding Review 相同，可以在 config 用 `stages.clarify.consistency.thinking` 調整。
- Consistency Check 失敗時，這個 Round 就失敗，而且當輪的 Decision 不會寫入：狀態會還原到這個 Round 開始前，續跑時整個 Round 重新執行。不會跳過檢查、讓可能互相矛盾的 Decision 留在狀態裡。
- 衝突題沿用 Follow-up Question 的編號（`FQ-n`）和既有的回答、解讀、Grounding Review 流程，沒有另設一套結案機制。
- 誤報的代價是使用者多答一題，而且可以用 `/na` 略過；漏報的代價則是 Write 寫出錯誤的情境。所以 prompt 也會要求檢查「後來的 Decision 用自己的話縮小了先前的範圍」這種情況。

## Considered Options

- **在收尾時才檢查一次**：收尾輪不能提問，衝突只能記成未解決；而且使用者已經離開，前後文也不在記憶中了。所以不採用。
- **每輪把所有 Decision 兩兩重新比對**：成本隨輪數增加，而舊的組合先前已經比對過。所以不採用。
- **由 Consistency Check 直接寫出修訂後的 Decision，請使用者 `/ok`**：這會讓 Decision 的內容來自模型，不是使用者，違反 ADR 0007。所以不採用。
