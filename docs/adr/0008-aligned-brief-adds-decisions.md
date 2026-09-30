# Aligned Brief 保留原本的 Requirement Brief，只追加 Decision

Clarify 的產出 `02-aligned.json`（Aligned Brief）把 Requirement Brief **原樣**帶過來，另外附上 Decision 清單。即使使用者推翻了某條事實，例如「取消期限是 7 天，不是 3 天」，也不會刪除或改寫原本的 Business Rule。做法是由 Decision 以 `supersedes` 指向它，再由程式計算出 `supersededBy` 對照表。Decision 被使用者更正時也是同樣的處理：新的 Decision 以 `revises` 指向舊的一條，舊的一條保留並標為 revised。

會這樣設計有兩個理由。第一，和 ADR 0003 一致：模型只下判斷，資料由程式改，所以 Evidence 不會在改寫過程中被弄壞。第二，每一個結論都能追溯：事實追溯到原文（Evidence），Decision 追溯到使用者原話（Answer）。Write 同時看得到「文件原本怎麼寫」和「使用者後來怎麼決定」。

## Consequences

- Write 讀取事實時，必須先查 `supersededBy`，不能直接使用 Brief 中的事實。Decision 的 `effect`（replace / confirm / reconcile / new）由程式從 `supersedes` 與 `confirms` 推導並寫入檔案，讓 Write 不需要自己推導。
- 仍未決的題目會帶著狀態交給 Write：使用者主動延後的是 `deferred`，流程結束時仍沒有答案的是 `unresolved`。Write 分別標為 `@deferred` 和 `@open`，不會無聲省略。
- 依 CONTEXT「每個 Stage 只讀取前一個 Stage 的產出」，Aligned Brief 必須能獨立使用。所以它內嵌完整的 Brief，而不是引用 `01-brief.json`。

## Considered Options

- 直接修補 Brief，推翻的事實就刪掉，新的結論寫成事實：Write 讀起來最簡單，但改寫過程會破壞 Evidence，新寫出的「事實」也沒有原文出處，所以不採用。
- 只交出問答紀錄，讓 Write 自己理解：這等於把解讀工作推給 Write，而 Write 的職責是寫 Gherkin，所以不採用。
