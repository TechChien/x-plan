# OpenTelemetry 補充檔案 trace，預設關閉、預設不送內容

x-plan 可以把每個 Run 的過程以 OpenTelemetry span 送到可觀測性 backend（例如 Langfuse），用來在 UI 中瀏覽 Run → Round → agent → turn 的樹狀結構，並看跨 Run 的 token 與延遲。這是**補充**：`traces/*.jsonl`、`*.md` 照舊永遠寫出，是完整紀錄的正本。Backend 不在線、匯出失敗都只印一次警告，不影響 Run 的結果。

Tracing 預設關閉。`telemetry.enabled` 為 `true`，或環境中有標準的 `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 時才啟用；`OTEL_SDK_DISABLED=true` 一律關閉。關閉時只載入零依賴的 `@opentelemetry/api`，它在沒有註冊 SDK 時是 no-op，所以程式中不需要到處判斷「有沒有開」。

Span 預設只帶 metadata：token、時間、狀態、id、重試次數。Prompt、CoT、tool 參數（也就是擷取出的需求）與使用者的 Clarify 回答，只有在 `telemetry.captureContent: true` 時才送出，因為需求文件可能屬於機密，而 backend 可能是共用的服務。

## Consequences

- Span 依 OTel GenAI semantic conventions 命名：每個 submit task 是 `invoke_agent <label>`，底下每次模型回應是 `chat <model>`，每次交卷是 `execute_tool <name>`。Check 在 tool span 內執行，所以 Grounding Review 會掛在觸發它的 `submit_round` 底下。Agent 層的 token 總數放在 `xplan.usage.*`，不用 `gen_ai.usage.*`，避免 backend 加總時重複計算。
- 每次執行程序是一條 trace，以 Run id 作為 session 串起來。續跑的 Clarify 以 span link 指回這個 Run 之前的 trace；新的 Clarify 以 span link 指向上游 Extract Run 的 trace。不嘗試把跨天續跑接進同一條 trace，因為那需要保存並恢復 root span，而且多數 backend 無法處理跨天才結束的 span。
- 等使用者回答的時間是 `clarify.await_user` span，標有 `xplan.await_user=true`，延遲統計可以把它排除；否則 Clarify 的延遲全是人的思考時間。
- `run.json` 的 `telemetry.traces[]` 記錄每條 trace 的 id、root span id，以及每個 task label 對應的 span id。Feedback 靠它找到產出某個條目的 span（[ADR 0014](0014-feedback-is-local-first.md)）。
- Endpoint 優先使用標準的 `OTEL_EXPORTER_OTLP_*` 變數，讓一般的 OTel 設定方式不變；沒有時，從 config 的 `langfuse` 區塊推導出 endpoint 與 Basic auth。
- v1 只送 traces，不送 metrics：Langfuse 不接收 OTel metrics，token 與延遲可以從 span 推算。

## Considered Options

- 以 OTel 取代檔案 trace：少寫一份資料，但 Run 的完整紀錄就要依賴外部服務是否在線，而且失敗的 Run 可能無法重現。不採用。
- 使用 `@opentelemetry/sdk-node` 加上 auto-instrumentation：會把對 LiteLLM 的 HTTP 呼叫也變成 span，與 `chat` span 重複，製造雜訊。不採用；x-plan 只在自己的 seam（`runTraced`、Stage、Round）上建立 span。
