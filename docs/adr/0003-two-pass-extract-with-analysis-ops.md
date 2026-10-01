# Extract 採 Facts／Analysis 兩段式，Analysis 只輸出操作指令

Extract 先以每個 bin 一個 Facts agent 擷取事實型 section（map），由程式合併並重新編號（merge），再由單一 Analysis agent 閱讀合併後的事實，輸出 `merges`／`contradictions`／`openQuestions`／`assumptions` 四種操作指令，由確定性的 `applyAnalysis` 套用（reduce）。只有看得到全部事實的一方才能判斷跨檔案的語意重複與矛盾；而讓模型只做「判斷」、由程式「動資料」，可以確保 Evidence 與 id 不會在重寫中被模型改壞，且套用過程可單元測試。

## Consequences

- Analysis agent 看不到原文，其產出的 Contradiction 等條目以 `relatedIds` 指向事實，Evidence 由程式繼承。
- 合併時只保留 keep 條目的文字，不融合描述；同時被宣告為重複又互相矛盾的條目視為模型錯誤、回饋重試。
- 輸入未超出 budget 時 bin 數為 1，仍走同一條路徑。
- **Merge 一律重新編號**，即使只有一個 bin、即使有條目被剔除，所以 trace 中模型寫的 id 與 Brief 中的 id 可能不同（例如被拒的 BR-2 移除後，原 BR-3 變成 BR-2）。每個 bin 的對照表記錄在 `run.json` 的 `idMaps`，精確名稱去重記錄在 `deduped`。不為單一 bin 保留原 id，是為了只維持一條路徑。
- 被 Analysis 移除的條目（merge 的 drop）完整保留在 `01-analysis-log.json`，供人工與 eval 檢視每一個判斷。

## Analysis 不自行解答 Open Question

Analysis 只能合併重複的 Open Question，不能判定問題「已有答案」而將其移除；所有問題都留到 Clarify，由使用者確認。

理由：模型移除問題後，使用者不一定會回頭檢查那個判斷是否正確，被誤判的真問題就會無聲地消失，Clarify 也不會再問。實測中，Analysis 曾在只有一個 bin 時移除「CPE 要用資料表對應還是呼叫端點」「是否也計算硬體」等真正待確認的問題，理由是「沒有事實提到另一種做法」，並把同樣的內容改寫成 Assumption，等於以推論取代了使用者的確認。多問一題的代價，遠小於漏問一題。

- `AnalysisSubmissionSchema` 不允許額外欄位，Analysis 沒有任何能移除問題的操作；prompt 也明確寫出不得解答問題、Assumption 不得取代 Open Question。
- **Assumption 也不得寫出 Open Question 的推測答案**（2026-10-01 修訂）。原本的規則是「保留問題，另把推測寫成 Assumption」，結果同一件事在 Brief 裡出現兩次（例如 OQ「admyn_id 是否就是 AdminUUID？」與 ASM「admyn_id 就是 AdminUUID」）：Clarify 先問 OQ，Decision 確認了那條 ASM，但 ASM 仍是待確認項目，又被問一次。實測一次 27 題的 Clarify 中有 5 題是這樣的重複。推測的答案不必保留：Clarify 為每個題目產生建議答案時會重新推論。此規則只寫在 prompt，由 eval 的 `assumptions.shouldNotDuplicate` 標籤量測，不以程式檢查（是否「回答了某個問題」是語意判斷）。
- 跨批次的定義型誤報（讀不到 glossary 的批次問「會員是什麼？」）改由 `binInfo` 抑制；抑制不了的會留在 Brief，由使用者在 Clarify 一次看完。eval 以 `shouldNotBeRaised` 標籤量測這類誤報的數量。
