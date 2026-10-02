# 全部 Feature 寫完後，以 Vocabulary Normalization 統一用語

每個 Feature 的 writer 平行執行、看不到彼此的 steps（ADR 0015），同一件事可能在 FEAT-1 寫「會員已登入」，在 FEAT-2 寫「使用者登入系統」。這份文件是 PM、R&D、QA 討論的共同基礎，同一個概念有三種說法，討論時就會出現「使用者和會員是不是同一種人」這類不必要的問題。

因此在全部 writer 完成之後，加一個 **Vocabulary Normalization** 角色，概念類似本專案的 CONTEXT.md：

1. 讀取全部 Gherkin 文字，整理出 **Vocabulary**：每個概念一個標準用語，附上定義、要避免的說法（`avoid`）與出處。
2. 指出哪些地方要把哪個說法換成標準用語，交出替換操作 `{ loc, from, to }`。`loc` 由程式為每一段文字標出，例如 `SCN-3/step/2`。
3. 程式只在指定的 `loc` 內逐字套用替換，跳過 `<…>` 佔位與引號中的原文值，並記錄每一筆替換。

標準用語的優先順序：Brief 的 Term、Actor、Domain Entity 原名（出自需求文件，有 Evidence）→ 使用者在 Decision 中的用詞 → steps 中最常出現的說法。不能新創一個所有來源都沒出現過的說法。

## 這是一次試行

除了 schema 驗證與語言檢查之外，這個角色**不做程式檢查**：不檢查標準用語是否出自來源、`to` 是不是詞條的標準用語、替換後意思是否改變。先觀察效果，由 eval 量測：

- 用語一致性：標註的變體說法在 steps 中出現的次數，統一前（writer 的原始文字）與統一後各算一次。
- 錯誤合併：標註為不同概念的詞被替換成彼此的次數。
- 意思偏移：統一前後的必要情境召回率、被推翻內容出現數有沒有變差。
- 替換總數、跳過的替換數、詞條數、成本。

`stages.write.vocabulary.enabled`（預設 `true`）可以關掉這個角色做對照。結果不理想時，再決定要加程式檢查、改變位置，或撤掉。

## Consequences

- 替換在 Scenario Review 之後執行，替換後的文字不再經過 review。review 的迴圈維持在單一 Feature 內，流程最單純；替換紀錄完整保存在 `03-vocabulary.json`，`03-trace.json` 保留替換前的原始文字，意思被換偏了可以追查。
- 模型只交出替換操作，不改寫整段文字（ADR 0003）。整段改寫可能順手改了句意，而且沒有紀錄；全域字串替換則會誤傷，例如把「會員」換掉時連「VIP 會員」也一起換。`from` 在指定的 `loc` 找不到時跳過並記成 warning，不退回。
- 產出 `03-vocabulary.md`（格式比照 CONTEXT.md：標準用語、定義、`_Avoid_`、出處、替換次數）與 `03-vocabulary.json`；`03-spec.md` 的用語表連到這份文件。
- 之後有 LLM 要寫入這個 Run 時，Vocabulary 會放進它的 prompt。例如 `--only` 補寫某個 Feature 時，writer 一開始就用標準用語，補寫完只對該 Feature 再跑一次，沿用既有詞條，可以追加。
- 這個角色失敗時只寫 warning，以 writer 的原始文字渲染，Run 的 status 不受影響：用語不一致不會讓文件失去追溯性。
- thinking 預設比 writer 低一級，可用 `stages.write.vocabulary.thinking` 調整。
- 名稱不用 Glossary：CONTEXT.md 的 **Term** 已經是「需求文件中有定義的名詞」，而且把「Glossary entry」列為要避免的說法。Vocabulary 涵蓋 Gherkin 中出現的所有說法，不要求原文有定義。

## Considered Options

- **接受差異，只靠規則要求 Actor、Term 用原名**：無法處理原文沒有定義、但各 writer 各自命名的概念。不採用。
- **Writer 依序執行，每個 writer 看到前面已用過的句子**：會失去平行，前綴也會越來越長。不採用。
- **Review 檢查替換後的文字**：Review 退回時 writer 重寫，重寫後的內容要再統一一次，會形成迴圈。不採用。
