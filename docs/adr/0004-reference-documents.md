# 參考資料以 Reference Document 標記，並在每一批附上需求文件

真實專案的輸入常是「幾行需求 + 一大份參考資料」。以 `spec_to_test` 實測（req.md 5 行，另附 CVE 服務 API 手冊與整個 `admyn` 資料庫的 schema 目錄）：Brief 有 124 條，212 筆 Evidence 中 122 筆引自資料庫目錄，產生 47 個 Domain Entity、Vendor／Dealer 等無關 Actor，還把寫給 AI agent 的「先讀 outline 再載入資料表」當成 Feature 與 Constraint。模型沒有做錯：Facts prompt 要求照實記錄文件內容，而它無從得知哪些文件是需求、哪些只是參考。

因此由使用者標記 Reference Document：放在指定目錄的頂層 `references/` 子目錄下即自動成立，不方便搬移時再以 `--reference <glob...>` 補充（兩者合併）。目錄慣例讓標記跟著文件走，重跑時不必記得參數；只認頂層的 `references/`，避免深層同名目錄被意外當成參考資料。它們在 prompt 中帶 `role="reference"`，Facts 的規則是：需求文件決定範圍，參考資料只擷取需求用得到的部分，本身不產生 Actor 或 Feature；它描述的外部系統是 Dependency。

相關性只有同時看到需求文件才能判斷，所以裝箱時需求文件一定與參考資料同批：`auto` 讓第一批擁有需求文件，其餘每一批把需求文件以 `role="context"` 再附一次；`context` 只供判斷，不能擷取或引用，由既有的「Evidence 只能引用本批檔案」檢查保證。

## Consequences

- 標記由使用者決定，不讓模型自行分類文件。精神與 ADR 0001 相近：模型看到的輸入（包括每份文件的角色）應是確定、可重現的，模型只負責在這個前提下判斷內容。
- 需求文件超過預算一半時不重複附上，參考資料退回一般裝箱，執行時警告相關性無法判斷。需求文件通常很短，這種情況預期罕見；真的發生時，應先拆小需求文件，而不是讓每一批的預算被重複的 context 吃掉。
- Analysis agent 的 prompt 列出參考資料檔名，並限制只在需求事實依賴它們時才對其提問或假設。Analysis 不新增「剔除無關事實」的操作；過濾在 Facts 階段完成，避免 Analysis 需要判斷它看不到原文的相關性。
- 參考資料規則只在有 Reference Document 的 Run 才放進 prompt，所以沒有使用 `--reference` 的 Run，送出的 prompt 與先前完全相同，既有 eval 結果仍可比較。
- 召回率量不到雜訊，所以 eval 新增 `unexpected` 標籤與「條目數」。`eval/cases/cpe-inventory` 以上述實測資料建立（公司內部資料，已加入 `.gitignore`，只存在本機）；加入本機制前的那次執行，以此案例重新計分為召回 9/9、`unexpected` 11/11 命中、124 條，作為比較基準。
