# Feedback 以本機 jsonl 為準，backend 只是鏡像

`x-plan feedback` 讓人評價某個 Run 的產出：對 Brief 條目下 verdict、指出漏掉的事實、給整個 Run 打分數。Feedback 寫在**那個 Run 的目錄**中的 `feedback.jsonl`，這是正本。設定了 Langfuse 時，Feedback 另外以 score 的形式同步過去，掛在產出該條目的 span 上；Langfuse 上的資料只是鏡像，刪掉也能從本機重建。

Feedback 不是 Stage，也不是 Run：它不呼叫模型，也不產生交給下一個 Stage 的東西，只是人對某個 Run 的附註。因此寫入被評價的 Run 的目錄，不違反 [ADR 0010](0010-stage-runs-form-a-tree.md)「下游 Run 不寫入上游目錄」，因為那條規則規範的是 Run 之間的關係。

`feedback.jsonl` 只追加、不修改，與 Answer 相同。同一位 author 對同一條目再評價一次，就追加一筆 `supersedes` 前一筆的紀錄；撤回則追加一筆 `retracts`。每筆都保存條目當下的原文快照，因為 Brief 之後可能被重跑覆寫，日後把 Feedback 轉成 eval 案例時，不能依賴當下的 Brief。

## Consequences

- 同步狀態（哪一筆已送出、對應的 score id、何時被刪除）另存在 `feedback-sync.json`。它是機器的狀態，會被改寫，刪掉的代價只是全部重送一次；與記錄「人說了什麼」的 jsonl 分開，兩者的規則才能各自保持單純。
- Score id 由 Run id 與 Feedback id 決定，重送會取代而不會重複。被取代或撤回的 Feedback，同步時會刪除它在 backend 上的 score。
- 條目的 span 由 Extract 寫在 `run.json` 的 `provenance` 決定：合併後保留的是哪個 session 的文字，評分就掛在那個 session 的 span 上，其他貢獻 evidence 的 session 寫進 comment。Feedback 只查這張表，不自行重建 merge 的規則。
- Run 當時沒有啟用 OTel 時，Feedback 照常寫入，只是不帶 trace，也不會送出。
- Missing 不會互相取代，因為每一筆指的是不同的事實；不同 author 的評價並存。

## Considered Options

- 只把 Feedback 送到 backend（Langfuse score 或 Phoenix annotation）：最省事，但資料就鎖在某個服務裡，無法與 `eval/cases` 的人工標註接起來，換 backend 時也會失去全部紀錄。不採用。
- 把 Feedback 視為一種 Run，放在 `.x-plan/runs/feedback-…/`：符合 ADR 0010 的字面規定，但同一個 Run 的評價會分散在多個目錄，查詢某個 Run 的所有評價時必須掃描整個 runs 目錄。不採用。
