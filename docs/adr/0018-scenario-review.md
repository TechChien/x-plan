# Scenario 寫入前先經 Scenario Review

覆蓋規則（ADR 0016）只保證每條該寫的條目都被引用，不保證內容寫對：Scenario 引用了 DEC-1（7 天），Then 卻寫成 5 天，程式檢查一樣會通過。允許 Derived Scenario（ADR 0017）之後，「多寫了一點」的風險更高。因此比照 Clarify 的 Grounding Review（ADR 0011），writer 交卷、通過程式檢查之後，由第二個 agent 做 **Scenario Review**。它只挑錯、不改寫，修正一律退回 writer。

## 判定方式

- reviewer 每次只看一個 Feature 的 Scenario，每個附上它引用的條目全文：事實附 Evidence 引文，Decision 附結論與使用者原話。它看不到其他條目，所以沒有別的材料可以拿來當依據。
- reviewer 逐句（每個 step、每個 Examples 列）標註：根據是哪些條目、是不是由引用的條目必然推得、有沒有和引用的條目相反、具體數值出自哪個條目。
- 最後的判定由程式從回報推出：

| 判定 | 意思 | writer 要做的事 |
|---|---|---|
| `unsupported` | 寫了引用的條目沒說的內容 | 刪掉沒有根據的部分 |
| `contradicts` | 和引用的條目相反 | 改正 |
| `invented-value` | 具體數值沒有出處 | 改成 `<…>` 佔位 |
| `underived` | 標 `@derived` 但推不出來 | 刪掉推不出的部分，或降為 `@open` |
| `misattributed` | 內容其實來自別的條目 | 改正 sourceIds |

## 處理方式

被標記的 Scenario 以 tool result 退回 writer，與程式檢查共用 3 次交卷額度（ADR 0002）。重交 3 次後仍被標記的 Scenario **照樣寫進 `.feature`**，標 `@unverified`，reviewer 的意見寫在 `03-trace.json` 並列在 `03-spec.md`。

這一點和 Clarify 不同：Clarify 中被拒的 Decision 不寫入，因為 Decision 一旦寫入就會被當成使用者說過的話，下游也不會再檢查。Write 的產出是給人討論的文件，一個「可能多寫了一點」的 Scenario 擺在那裡、而且標得很顯眼，比直接消失好；直接丟掉還會讓它引用的條目變成沒有覆蓋。

## Consequences

- 每個 Feature 的每次交卷多一次 LLM 呼叫，但只送本 Feature 的 Scenario 與它引用的條目，輸入遠小於 writer。thinking 預設比 writer 低一級（xhigh、high 降為 medium，medium 降為 low），可用 `stages.write.review.thinking` 調整。
- 程式檢查沒通過時不呼叫 reviewer。
- reviewer 本身失敗時，該 Feature 的 writer 視為失敗（標 `@unwritten`，可用 `--only` 補寫），不會跳過檢查。
- 「必然推得」的界線與 ADR 0011 相同，只能靠 prompt 裡的正反例描述，並用 eval 的「Review 攔下數」與 `@unverified` 數觀察。
- 名稱刻意不沿用 Grounding Review：Grounding Review 比對的是 Decision 與使用者原話，Scenario Review 比對的是 Gherkin 與 Aligned Brief 中的條目，兩者的材料與判定都不同。

## Considered Options

- **不做語意檢查，只靠程式檢查與 prompt**：看不出內容寫錯、數值編造、推導過頭，不採用。
- **由 reviewer 直接改寫 Scenario**：兩個角色都在寫 steps，責任不清，也違反 ADR 0011 的分工。不採用。
- **被標記的 Scenario 直接丟棄**：見上方「處理方式」，不採用。
