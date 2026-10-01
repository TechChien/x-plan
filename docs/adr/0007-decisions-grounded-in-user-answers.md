# Decision 只能以使用者的 Answer 為依據，Agenda 由程式維護

> 2026-10-01：Decision 的內容是否真的來自它的 Answer，另由 Grounding Review 檢查；答非所問而且無法再追問的題目轉為 unresolved，不再被規則 1 硬逼出 Decision。見 [ADR 0011](0011-grounding-review-before-decisions-are-written.md)。

Clarify 的 agent 只能**解讀** Answer，不能**產生**答案。每一條 Decision 都必須用 `answerRef` 指向一則真實存在、而且有作答內容的 Answer，也只能結案已經有 Answer 的 Agenda Item。Agenda Item 的狀態由程式維護，agent 只提交操作。各狀態轉移分別由誰觸發如下：

- **只有使用者**能讓題目進入 deferred（延後）或 dismissed（不適用）。
- **agent** 只能讓題目進入 decided（有 Decision 結案），或 followed-up（回答不夠清楚，改為追問）。
- 其餘轉移由**程式**執行：選題、回到 pending、收尾時轉為 unresolved。

這是 ADR 0003「Analysis 不自行解答 Open Question」原則在 Clarify 的延伸。模型如果能自行判定「這題已有答案」或「這題不適用」，被誤判的真問題就會無聲消失，而使用者不會回頭檢查。

## Consequences

- **Answer 不會無聲消失**：上一 Round 每一則有作答內容的 Answer，都必須被至少一條 Decision 結案，或被至少一題 Follow-up Question 接手，否則交卷被退回。最後一次交卷時被拒的 Decision 會讓該題維持 answered，下一 Round 重新解讀；流程結束時仍未決的題目，附上使用者原話交給 Write。
- agent 認為某題已被其他 Decision 涵蓋時，只能在題目上標註 `coveredBy` 當作提示，仍然需要使用者輸入 `/ok` 確認才會結案。代價是使用者多按一次。
- 使用者用 `/ok` 採用建議答案時，記錄的是當時建議答案的快照文字，讓 Decision 依據的是一段具體內容，而不是「使用者按了確定」這個動作。
- 題目 id 由程式編號（Decision 為 `DEC-n`，Follow-up Question 為 `FQ-n`，使用者主動補充為 `NOTE-n`），agent 不寫 id，id 就不會被改壞。
- Follow-up Question 的追問深度最多 2 層，gherkin-gap 題每 Round 最多 2 題。沒有上限的話，模型可能沿著一個細節無限追問。

## Considered Options

- 允許 Decision 結案「還沒問過、但 Answer 已順帶回答」的題目：可以少問一題，但這正是上述「模型自行判定已有答案」的失敗模式，所以不採用。
- 另設一個專門負責解讀 Answer 的 agent，與出題的 agent 分開：每 Round 的 LLM 呼叫會加倍，而解讀和追問本來就需要同一份上下文，所以不採用。
