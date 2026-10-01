# Decision 寫入前先經 Grounding Review

ADR 0007 只保證每條 Decision 都指向一則有作答內容的 Answer，但不檢查 Decision 的**內容**是否真的來自那則 Answer。實際執行時觀察到三種情況，全都通過了程式檢查：

- **多加了內容**：Decision 寫進使用者沒說的細節，大多是從建議答案或常識搬來的。例如使用者只回答「One shared service key for all tenants」，Decision 卻寫成「…held in the job's secret store」。
- **只答一部分**：題目問兩件事，回答只答其中一件，題目卻被標成已決定，沒答的那一半就此消失。
- **答非所問**：回答根本沒在回答這一題，卻被寫成 Decision，例如「本版不規定起算日」。這種情況還是由 ADR 0007 的規則 1 逼出來的：追問被使用者回答 `/na` 之後，原題回到 answered，規則 1 要求它必須被結案，模型只好從一則不相干的 Answer 寫出一條 Decision。

因此在 interpreter 交卷、通過程式檢查之後，Decision 寫入之前，由第二個 agent 做 **Grounding Review**。它只負責挑錯、不改寫，修正一律退回 interpreter 處理，所以「解讀 Answer」仍然只由一個角色負責。

## 判定方式

- reviewer 只看本輪提交的 Decision，每條附上：要結案的題目原文、使用者當時看到的建議答案與選項、Answer 原文與回答方式，以及被追問題目自己的 Answer、Decision 提到的 Brief 條目（含原文引述）、先前的 Decision。它看不到對話紀錄或其他題目，所以沒有別的材料可以拿來當依據。
- reviewer 先把結論拆成一句一句的主張，逐句標註根據。可以算作根據的只有：Answer 本身、由 Answer **必然推得**的結論、使用者採用的建議答案（`/ok`，或在回答中表示照建議）、Brief 條目、先前的 Decision。「合理但沒說」的內容不算。
- reviewer 另外回報兩件事：Answer 有沒有回應題目本身，以及題目中有哪些部分沒有任何 Answer 回答。
- 最後的判定（`embellished` / `partial` / `off-topic`）由程式依 reviewer 的回報推出，判定結果寫入每個 Round 的 `reviews`。

## 處理方式

| 判定 | interpreter 要做的事 |
|---|---|
| 多加了內容（`embellished`） | 刪掉沒有根據的部分後重交 |
| 只答一部分（`partial`） | 為沒答的部分提出追問（`parentId` 指向原題）；Decision 只能保留使用者說過的部分 |
| 答非所問（`off-topic`） | 刪掉這條 Decision，改為追問，把原題再問一次 |

追問有時已經不可能：收尾輪不能再提問、追問深度已達上限，或者這題已經追問過一次。這時的處理方式：
- `partial` 不再要求追問，Decision 只保留使用者說過的部分。
- `off-topic` 的題目由程式標成 `leftOpen`，題目轉為 unresolved，規則 1 對它豁免。這補上了 ADR 0007 規則 1 的缺口：答非所問的 Answer 不必、也不能被硬寫成 Decision。

重交 3 次後仍被標記的 Decision 不會寫入，記到 `02-rejected.json`，它的 Answer 在下一 Round 重新解讀，與 ADR 0007 中被程式檢查拒絕的 Decision 處理方式相同。reviewer 本身失敗時，這個 Round 就失敗，進度已存檔，可以續跑；不會跳過檢查繼續執行。

## Consequences

- 每次交卷多一次 LLM 呼叫，但只送本輪的 Decision 和相關的 Answer，輸入遠小於 interpreter 的輸入。reviewer 的 thinking 預設比 interpreter 低一級，可以在 config 用 `stages.clarify.review.thinking` 調整。
- 程式檢查沒通過時不會呼叫 reviewer，等 interpreter 修好格式再審。
- 交卷時的檢查（`SubmitTool.check`）改為可以是非同步的。
- reviewer 的界線在「必然推得」：寫得太寬會放過幻覺，寫得太嚴會退回合理的改寫。這條界線只能靠 prompt 裡的正反例描述，並用 eval 的「Review 攔下」指標觀察。

## Considered Options

- **Decision 先寫入、事後標記可疑，交給使用者確認**：可疑的 Decision 會先進入 Aligned Brief，使用者不一定會回頭看，所以不採用。
- **由 reviewer 直接改寫 Decision**：會變成兩個角色都在解讀 Answer，違反 ADR 0007 的分工，所以不採用。
- **用程式比對關鍵字判斷 Decision 是否有根據**：中文的改寫與推論無法靠字面比對判斷，所以不採用。
