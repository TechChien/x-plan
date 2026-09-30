# Clarify 的多回合問答由 orchestrator 驅動，每個 Round 是一次獨立的 submit-task

Clarify 需要多次向使用者提問。我們不給 agent 一個 `ask_user` 工具、讓單一個長時間存活的 session 自己決定何時提問；而是由 orchestrator 驅動迴圈，每個 Round 開一個新的 session。每一 Round，程式注入 Requirement Brief、先前的問答紀錄與目前的 Agenda 狀態，agent 透過 `submit_round` 交卷，內容是對上一輪 Answer 的解讀，以及本輪要問的題目。程式收下後向使用者提問、記錄 Answer，再開下一 Round。

理由與 ADR 0001／0002 相同：模型看到的輸入由程式決定、可以重現，結構化輸出和重試沿用既有的 `runSubmitTask`。gpt-oss 等級的模型在長時間、多步驟的 tool-use 中容易跑偏。每 Round 各自獨立，也讓每一 Round 都能單獨留下 trace、單獨重跑，中斷後也能從任何一 Round 續跑。另外，`SessionTool.execute` 是同步函式，如果要做 `ask_user`，就得改成 async，session 也要在等人回覆時一直掛著。

## Consequences

- 每 Round 都要重新注入完整的 Brief，輸入成本會隨 Round 數累積。為了讓 vLLM 的 prefix cache 命中，user message 依變動頻率由低到高排列：`<brief>`（不變）→ `<log>`（依時間排序、只追加）→ `<state>` → `<pending-answers>` → `<prepare>`。Brief 不加任何標註，更正寫成 log 中的新紀錄、不回頭修改舊紀錄。以測試保證第 k Round 的 prompt 在 `<log>` 結尾之前的部分，是第 k+1 Round 的逐字前綴。這個排法同時讓本回合的任務離生成位置最近，所以即使部署環境沒有 prefix cache 也不吃虧。
- 狀態存放在 run 目錄的 `02-state.json`，每次記錄 Answer、每次套用交卷結果後都會存檔。Answer 只能追加，Agenda 狀態可以從 Brief、Answer 與 Decision 重新推導。
- 使用者提供 Answer 的管道抽象成 `Answerer` 介面。終端機、腳本、eval 的模擬使用者都只是不同的實作；以後要加上「寫檔、填答、續跑」的非同步模式時，不需要改動迴圈本身。
- 正常收斂時不需要額外的收尾回合。只有使用者輸入 `/done` 或達到 Round 上限時，才跑一次只能交 Decision、不能出題的 `submit_final`，確保最後一批 Answer 也會被解讀。

## Considered Options

- 單一 session 加上 `ask_user` 工具：對話比較自然，也不必重複注入 Brief。不採用的原因如上：跑偏風險、無法重現、需要改寫 agent 層，而且中斷之後無法續跑。
