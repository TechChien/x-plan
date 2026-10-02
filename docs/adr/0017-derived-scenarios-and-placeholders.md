# 允許 Derived Scenario，但必須標示，規則沒給的值只能寫成佔位

BDD 的價值有一大塊在邊界案例：「到貨後 7 天內可退」本身就要求第 7 天可退、第 8 天不可退。如果 Write 只能寫原文或使用者明說的例子，這些邊界就不會出現在文件裡。但 ADR 0007 的原則是「模型不能替使用者作答」，Write 也不能把自己的推論偽裝成需求。

因此 Write 允許 **Derived Scenario**，界線比照 ADR 0011 的「必然推得」：

- 可以寫：由 Business Rule 或 Decision **必然推得**的情境與數值。「7 天內可退」必然推出「第 8 天不可退」。
- 不能寫：規則沒有給的行為或值。「7 天內可退」推不出「不可退時顯示什麼訊息」，也推不出商品名稱、金額。
- 規則沒給、但 step 需要的值，一律寫成明確的佔位，例如 `<任一一般商品>`，不得編造。
- Derived Scenario 標 `@derived`。Scenario Outline 中，原文或 Decision 給的例子與推導出的例子分成不同的 Examples 區塊，`@derived` 標在後者，因為 Gherkin 的 tag 只能掛在 Examples 區塊上，不能掛在單一列上。

## Consequences

- 讀者一眼就能分辨「需求說的」與「模型推的」，討論時可以只針對 `@derived` 確認。
- 寫不出來的情境不硬寫，改成 `@open` 的 Scenario 骨架：已知的 Given、When 照寫，最後一行佔位的 Then 由程式依題目原文產生，例如 `Then <待決 OQ-3：已出貨的訂單能否退貨？>`。Clarify 中被延後的題目同樣寫成骨架，標 `@deferred`。跑測試的人可以用 `not @open and not @deferred` 排除。和任何 Feature 都無關的未決題目只列在 `03-spec.md`。
- NFR 只有在原文或 Decision 給了可量測的門檻時，才寫成 `@nfr` 的 Scenario；否則只列在 `03-spec.md`，避免寫出「系統應快速回應」這種無法驗證的 Then。程式以 NFR 的 `target` 欄位或 sourceIds 中有 Decision 作為判斷依據。
- Step 用宣告式的業務語言（「Given 會員等級為 VIP」），不寫 UI 操作細節，除非原文就是在描述 UI。需求階段還沒有 UI，寫成命令式等於編造操作細節。
- 程式檢查不是 `@derived` 的內容中的數值都出現在它引用的條目中；`@derived` 的內容與「是否必然推得」交給 Scenario Review 判斷（ADR 0018）。

## Considered Options

- **嚴格模式：只寫 AC、BR、Decision 明說的情境與數值**：最安全，但邊界案例會全部消失，而那正是 PM、QA 最需要討論的部分。不採用。
- **自由發揮，寫出完整的範例**：讀起來最完整，但編造的值會被當成需求，違反 ADR 0007 的精神。不採用。
