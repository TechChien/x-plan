# 以 submit 工具取得結構化輸出

每個 agent 的產出一律透過呼叫一個自訂工具（如 `submit_facts`、`submit_analysis`）交付。工具參數就是輸出 schema（TypeBox，開啟 `constrainedSampling` 嚴格取樣）。驗證分兩層：

- **schema 驗證**由 PI 在呼叫 `execute()` **之前**自行執行，失敗時 PI 直接把錯誤回給模型，不會進入 `execute()`。
- **語意驗證**（Evidence 引文、id、引用）在 `execute()` 內執行。

兩種失敗都以 tool result 回傳，讓模型在同一個 session 修正；通過時回傳 `terminate: true` 結束。PI 沒有 `response_format`／JSON mode，而從自由文字中解析 JSON 對 gpt-oss 等級模型不可靠；此做法讓 schema 在 provider 端就被約束，重試也不必重開 session。

## Consequences

- PI 的 schema 重試沒有上限，所以交卷次數由 orchestrator 從事件計算：`tool_execution_start` 算一次交卷（PI 在驗證參數前就發出它）；錯誤結果但 `execute()` 未被呼叫，即為 schema 失敗。schema 與語意失敗**共用** 3 次交卷額度（首次 + 2 次重試），用完即中止 session。共用的理由是對模型而言兩者都是「交卷被退回」，分開計算會讓最壞情況變成 5 次、token 成本難以預估。
- schema 錯誤的訊息由 PI 產生，不經過 `prompts/shared/validation-errors.md` 模板；內容記錄在 trace 中。
- 最後一次交卷時，語意驗證改為部分接受：不合格的條目移入 Rejected Item，其餘照常收下。

## Considered Options

- 在最終文字回覆中輸出 ```json 區塊再由程式解析：保留為 fallback（若部署環境無法 tool calling），驗證邏輯不變。
- 用寬鬆的參數 schema 讓所有驗證都進入 `execute()`，以統一錯誤訊息格式：會失去 provider 端的嚴格取樣，不採用。
