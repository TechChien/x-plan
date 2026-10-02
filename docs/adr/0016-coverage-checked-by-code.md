# Write 的覆蓋規則由程式檢查

模型寫出 20 個流暢的 Scenario 時，讀的人很難察覺 Aligned Brief 裡有一條 Business Rule 從頭到尾沒有出現。Clarify 保證「回答不會無聲消失」，Write 也要保證「應該寫成行為的條目不會無聲消失」，而且不能靠人去比對。outline 的每個 Scenario 都帶有 `sourceIds`（ADR 0015），所以這件事可以由程式檢查：比對「必須覆蓋的 id」和「實際被引用的 id」。

程式從 Aligned Brief 算出三個集合：

```
mustCover = 沒被推翻的 FEAT ∪ AC ∪ BR ∪ effect 不是 confirm 的 active Decision  − supersededBy 的 key
forbidden = supersededBy 的 key ∪ 未被確認的 ASM ∪ 非 active 的 Decision
notBehavioralAllowed = effect 為 new 的 active Decision
```

outline 交卷時檢查：

1. **覆蓋**：mustCover 中的每個 id，都要被某個 Scenario 引用，或列在 `notBehavioral` 並附上理由。FEAT 以「有一個至少含一個 Scenario 的區塊」算作覆蓋。
2. **禁止引用**：任何 sourceIds 都不得在 forbidden 中。退回訊息指出被推翻的條目應改引用哪條 Decision。
3. **AC 不能被降級**：每條 AC 至少被一個不是 `@derived` 的 Scenario 引用。AC 是原文親口給的例子，不能被模型推導出來的版本取代。
4. **逃生口有限**：`notBehavioral` 只能用在 notBehavioralAllowed 的 Decision 上，例如只是名詞定義的 Decision。BR、AC、FEAT 依定義就是行為，一律不能標。

outline 階段 steps 還不存在，所以 writer 交卷時另外檢查每個 step 與 Examples 列的 sourceIds：只能引用該 Scenario 在 outline 中的 sourceIds，以及 writer 輸入中共用的 Actor、Term、Domain Entity 等條目（ADR 0015）。forbidden 的條目不會出現在 writer 的輸入中，這個允許清單同時涵蓋了規則 2。

## Consequences

- ADR 0008 要求「Write 讀取事實時必須先查 `supersededBy`」，現在由程式保證，不靠 prompt 提醒。
- DEC 的 effect 為 `confirm` 時不在 mustCover 中：要寫進情境的是被確認的 Assumption 的內容，引用 Decision 或 Assumption 都可以。
- 只有一句描述、沒有任何 AC、BR、Decision 的 FEAT 也必須覆蓋：outline 寫一個只引用 FEAT、內容不超出 FEAT 原文的 Scenario，或是寫一個 `@open` 骨架指出缺少驗收條件。這類 Feature 正是 Clarify 的 gherkin-gap 應該問到卻沒問的，eval 會計數。
- 覆蓋規則只保證**有引用**，不保證**寫對**；內容是否忠於引用的條目由 Scenario Review 檢查（ADR 0018）。
- 共用 3 次交卷額度（ADR 0002）。最後一次交卷時部分接受：引用了 forbidden 條目的 Scenario 移入 `03-rejected.json`；仍沒被覆蓋的條目列在 `03-spec.md` 的「未覆蓋」清單與 `run.json` 的 warnings。
- `notBehavioral` 的條目與理由列在 `03-spec.md`，eval 計數，用來觀察模型是否濫用。

## Considered Options

- **只在 prompt 要求涵蓋所有條目**：漏寫無法被察覺，不採用。
- **由 reviewer agent 判斷覆蓋是否完整**：這是集合的比對，程式做得到、而且不會出錯，不需要 LLM。不採用。
- **`notBehavioral` 不設限制，或交給 reviewer 判斷理由是否成立**：前者讓模型可以把難寫的條目都標掉；後者多一次 LLM 呼叫，而 BR、AC 本來就不該有例外。不採用。
