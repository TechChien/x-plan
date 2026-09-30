# 題目排序是獨立的可替換 module

每一 Round 要問哪些題目、以什麼順序問，由 `src/clarify/ordering.ts` 這個獨立 module 決定。Round 的 agent 不負責排序，只負責替程式選出的題目寫題目文字與建議答案。

排序會影響使用者的 Answer，也會影響之後會出現哪些 Follow-up Question，但「最好的順序」目前還沒有結論。所以先實作一套確定的暫定規則，並把排序隔離在單一介面之後，將來可以換成規則更完整的版本，也可以交給一個獨立的 LLM 角色決定。不把排序交給 Round 的 agent，是為了讓它無法靠「一直不出某題」來避開那一題，也讓排序本身能單獨測試、單獨評估。

## 暫定規則

- **本 Round 要準備的題目**：從 pending 題目中依序選出前 N 題。順序為：CTR → OQ（依 blocking、high、medium、low）→ ASM（低信心度優先）→ gherkin-gap；同一級依 id 排序。Follow-up Question 依其所追問的原題類別排序。
- **本 Round 實際提問的批次**：agent 交卷後，依「新的 Follow-up Question → 程式指定並已準備好的題目 → gherkin-gap」的順序排列，只取前 N 題。被截掉的題目回到 pending，不會遺失。

## Consequences

- 介面設計成非同步，而且會回傳排序理由，讓以後換成 LLM 角色時不必改動呼叫端。理由會記錄在 trace 中。
- 呼叫端一律驗證排序結果：只能包含 pending 題目、不能重複、不能超過 N 題。不論排序由規則還是模型產生，都受同一個檢查保護。
