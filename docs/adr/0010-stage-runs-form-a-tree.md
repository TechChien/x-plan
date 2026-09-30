# 每個 Stage 的執行是獨立的 Run，記錄並驗證它的上游

每個 Stage 的每一次執行都是一個獨立的 Run，各有自己的 id 與目錄。所有 Run 並排放在 `.x-plan/runs/` 底下，id 帶有 Stage 前綴，例如 `extract-20260930-1530-a1b2c3`、`clarify-20260930-1600-d4e5f6`。每個 Run 的 `run.json` 都記錄 `stage` 與 `source`：Extract 的 `source` 是 Source Document 所在的目錄；下游 Stage 的 `source` 則是上游 Run 的 id、目錄，以及它讀取的那份產出的 sha256。下游 Run 只讀取上游 Run 的產出，不寫入上游目錄。因此同一個上游 Run 可以開出多個下游 Run，彼此互不影響，例如對同一次 Extract 做兩次不同回答的 Clarify，Run 之間就形成一棵樹。

原本的做法是讓 Clarify 把 `02-*` 寫進 Extract 的 Run 目錄。這樣一次 Extract 底下只能有一個 Clarify：第二次 Clarify 不是續跑第一次，就是把它覆寫掉。另外，只在目錄中並存檔案，無法得知產出彼此的來源關係。

## Consequences

- `x-plan clarify <run>` 依參數所指的 Run 決定行為。參數指向 Extract Run 時，開一個新的 Clarify Run；指向 Clarify Run 時，續跑它。參數可以只給 id，此時到 `.x-plan/runs/` 找，也可以給目錄路徑。
- 開新的下游 Run 時，上游必須是 `succeeded`。Extract 失敗時雖然仍會寫出 `01-brief.json`，但除非明確指定 `--allow-failed-extract`，否則 Clarify 會拒絕以它開始。
- 續跑時會重新計算上游產出的 sha256。上游被改寫過（例如有人用 `--out` 對同一個目錄重跑 Extract）時拒絕續跑。
- 產出本身也帶著 `source`，例如 Aligned Brief 記錄它來自哪一個 Extract Run、哪一份 Brief 的 sha256。Write 依同樣的規則指向某個 Clarify Run，因此整條鏈的每一段都能驗證。
- 產出檔保留 `01-`、`02-` 前綴。Stage 各自有目錄之後，前綴已不是必要，但在同時打開多個 Run 的檔案時，前綴能讓人一眼看出是哪個 Stage 的產出，改名的成本也比好處大。每個 Run 的後設資料一律叫 `run.json`。

## Considered Options

- 巢狀目錄（`runs/<extract-id>/clarify/<clarify-id>/…`）：從資料夾就看得出親子關係，但路徑會隨 Stage 加深，參數也必須給完整路徑，不能只給 id，所以不採用。之後若需要看整棵樹，可以加一個指令，從各 Run 的 `run.json` 列出來。
