# Extract 採 Facts／Analysis 兩段式，Analysis 只輸出操作指令

Extract 先以每個 bin 一個 Facts agent 擷取事實型 section（map），由程式合併並重新編號（merge），再由單一 Analysis agent 閱讀合併後的事實，輸出 `merges`／`resolvedQuestions`／`contradictions`／`openQuestions`／`assumptions` 五種操作指令，由確定性的 `applyAnalysis` 套用（reduce）。只有看得到全部事實的一方才能判斷跨檔案的語意重複與矛盾；而讓模型只做「判斷」、由程式「動資料」，可以確保 Evidence 與 id 不會在重寫中被模型改壞，且套用過程可單元測試。

## Consequences

- Analysis agent 看不到原文，其產出的 Contradiction 等條目以 `relatedIds` 指向事實，Evidence 由程式繼承。
- 合併時只保留 keep 條目的文字，不融合描述；同時被宣告為重複又互相矛盾的條目視為模型錯誤、回饋重試。
- 輸入未超出 budget 時 bin 數為 1，仍走同一條路徑。
- **Merge 一律重新編號**，即使只有一個 bin、即使有條目被剔除，所以 trace 中模型寫的 id 與 Brief 中的 id 可能不同（例如被拒的 BR-2 移除後，原 BR-3 變成 BR-2）。每個 bin 的對照表記錄在 `run.json` 的 `idMaps`，精確名稱去重記錄在 `deduped`。不為單一 bin 保留原 id，是為了只維持一條路徑。
- 被 Analysis 移除的條目（merge 的 drop、resolvedQuestions）完整保留在 `01-analysis-log.json`，供人工與 eval 檢視每一個判斷。

## `resolvedQuestions`：暫定，依 eval 結果決定去留

`resolvedQuestions` 讓 Analysis 標記「已被其他批次事實回答」的 Open Question 並將其移除，用來補 `binInfo` 未能抑制的跨批次誤報（例如讀不到 glossary 的批次問「會員是什麼？」）。風險是模型誤判而刪掉真問題，使 Clarify 漏問。

去留以 `pnpm eval` 的「resolvedQuestions 評估」決定：以同一次輸出比較套用與不套用，統計正確移除、誤刪真問題、漏解與未被提出。誤刪為 0 且正確移除 > 0 則保留；若「未被提出」居多而正確移除接近 0，代表 `binInfo` 已足夠，應移除此指令（連同 schema、`analysis.system.md` 的步驟 2 與 `applyAnalysis` 的處理）。決定後更新本節。
