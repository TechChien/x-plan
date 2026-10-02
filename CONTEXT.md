# x-plan

x-plan 將使用者提供的需求文件轉換為 BDD（Gherkin）需求文件，作為 PM、R&D、QA 討論的共同基礎。

## 流程

**Run**:
某個 Stage 的一次執行，有自己的 id 與產出，並記錄它讀取的上游 Run（Extract 的上游是 Source Document）。同一個上游 Run 可以有多個下游 Run，例如對同一次 Extract 做兩次 Clarify。
_Avoid_: Job, session, task, pipeline run

**Stage**:
x-plan 中職責單一的一個步驟，依序為 Extract、Clarify、Write；每個 Stage 的 Run 只讀取一個上游 Run 的產出。
_Avoid_: Phase, step

**Extract**:
第一個 Stage：從 Source Document 擷取需求資訊並產出 Requirement Brief，過程中不與使用者互動。
_Avoid_: Parse, ingest

**Clarify**:
第二個 Stage：以 Requirement Brief 為基礎，持續拷問使用者直到需求理解對齊。
_Avoid_: Grill, interview, Q&A

**Write**:
第三個 Stage：依據 Aligned Brief 寫出 Gherkin 需求文件，過程中不與使用者互動。
_Avoid_: Generate, render

## 需求資訊

**Source Document**:
使用者提供、作為需求來源的原始檔案。
_Avoid_: Input file, spec, attachment

**Reference Document**:
放在 `references/` 目錄下或由使用者另行標記為參考資料的 Source Document，例如資料庫 schema、API 手冊。只擷取需求文件用得到的部分，本身不產生 Actor 或 Feature；未標記的 Source Document 即為需求文件。
_Avoid_: Appendix, supporting file

**Requirement Brief**:
Extract 的產出，是從 Source Document 擷取出的結構化需求資訊，每條事實都附有 Evidence。
_Avoid_: Summary, digest, extraction result

**Evidence**:
指向 Source Document 中特定行範圍並附上原文引述的出處，用來證明一條擷取出的事實確實出自原文。
_Avoid_: Citation, reference, source

**Rejected Item**:
未通過 Evidence 驗證而被排除在 Requirement Brief 之外的條目，保留紀錄供使用者檢視。
_Avoid_: Error, dropped item

## Requirement Brief 的組成

以下每一類在 Source Document 未提及時皆可從缺；從缺是正確結果，不是缺陷。

### 事實（必須附 Evidence）

**Actor**:
會操作系統或受系統影響的人、角色或外部系統。
_Avoid_: User, persona, role

**Feature**:
系統提供、使用者可感知的一項能力。
_Avoid_: Function, capability, story

**Business Rule**:
系統行為必須遵守的業務邏輯判斷，通常帶有條件。
_Avoid_: Policy, logic

**Acceptance Criterion**:
Source Document 中用來判斷某個 Feature 是否完成的條件或範例；只收原文已有的，不是新編的情境。
_Avoid_: Test case, scenario, acceptance hint

**Non-functional Requirement**:
對品質屬性（效能、安全、可用性等）的要求。
_Avoid_: NFR, quality requirement

**Domain Entity**:
需要被記錄、具有屬性或狀態的業務物件。
_Avoid_: Model, object, table

**Term**:
Source Document 特有且在原文中有給出定義的名詞或縮寫；原文未定義的名詞不是 Term，而是 Open Question。
_Avoid_: Glossary entry, keyword

**Dependency**:
本系統所依賴的外部系統、服務或資料來源。
_Avoid_: Integration, external service

**Constraint**:
技術、環境或法規層面的限制；業務邏輯層面的限制屬於 Business Rule。
_Avoid_: Limitation, restriction

**Out-of-Scope Item**:
Source Document 明確表示不做的項目；不包含推論出的排除。
_Avoid_: Exclusion, non-goal

### 分析（由事實衍生）

**Open Question**:
Source Document 中模糊、缺漏或無法判斷之處，是 Clarify 拷問使用者的主要題材。
_Avoid_: Issue, TODO, gap

**Contradiction**:
兩條以上彼此衝突的事實；其 Evidence 繼承自所涉及的事實。
_Avoid_: Conflict, inconsistency

**Assumption**:
原文未明寫、由模型推論而來的內容；唯一允許不附 Evidence 的條目，必須與有原文依據的事實分開存放。Open Question 的推測答案不寫成 Assumption，問題留給使用者回答。
_Avoid_: Guess, inference

## 對齊

**Agenda Item**:
Clarify 中等待使用者確認的一個項目：來自 Requirement Brief 的 Open Question、Contradiction、Assumption，Clarify 過程中產生的 Follow-up Question，或使用者主動補充的說明。
_Avoid_: Question, ticket, issue

**Round**:
Clarify 中的一次問答循環：解讀上一輪的 Answer，再向使用者提出一批 Agenda Item。
_Avoid_: Turn, iteration, pass

**Answer**:
使用者對某個 Agenda Item 的原話回覆，包括採用建議答案；一經記錄就不修改。
_Avoid_: Reply, response, input

**Follow-up Question**:
Clarify 過程中新產生的 Agenda Item：可能是某則 Answer 不夠明確而需要的追問、為了寫出 Gherkin 而發現的缺口，或 Consistency Check 發現的衝突。
_Avoid_: Sub-question, clarification

**Decision**:
由一則 Answer 解讀出的結論，可以結案 Agenda Item、推翻或確認 Requirement Brief 中的條目，或更正先前的 Decision；每條 Decision 都必須能追溯到一則 Answer。
_Avoid_: Resolution, conclusion, ruling

**Grounding Review**:
Clarify 中，Decision 寫入前的檢查：由另一個 agent 確認 Decision 的每一句話都來自它所依據的 Answer，且 Answer 確實回答了題目；它只挑錯，修正一律由解讀 Answer 的 agent 處理。
_Avoid_: Hallucination check, verifier, validation

**Consistency Check**:
Clarify 中，每一 Round 寫入 Decision 之後的檢查：由另一個 agent 比對新的 Decision 與仍有效的 Decision、Brief 事實，找出不能同時成立的組合，交給使用者決定；它不做裁決。
_Avoid_: Conflict detector, validator, contradiction check

**Aligned Brief**:
Clarify 的產出：原樣保留的 Requirement Brief，加上全部 Decision 與每個 Agenda Item 的最終狀態，是 Write 唯一的輸入。
_Avoid_: Final brief, clarified brief

## 撰寫

**Outline**:
Write 中先決定要寫哪些 Feature、Rule 與 Scenario 的大綱：每個 Scenario 只有標題、種類與它引用的條目，不含 steps；由看得到整份 Aligned Brief 的單一 agent 產生，Coverage 在這一層由程式檢查。
_Avoid_: Plan, skeleton, draft

**Coverage**:
Write 中由程式檢查的規則：未被推翻的 Feature、Business Rule、Acceptance Criterion，以及效果不是確認 Assumption 的有效 Decision，都必須被某個 Scenario 引用，或明確標為不是行為並附上理由；被推翻的條目、未被確認的 Assumption 不得被引用。
_Avoid_: Completeness check, traceability check

**Derived Scenario**:
由 Business Rule 或 Decision 必然推得、而不是原文或使用者明說的 Scenario 或 Examples，例如由「7 天內可退」推出第 8 天不可退；一律標 `@derived`，規則沒給的值只能寫成佔位，不得編造。
_Avoid_: Inferred scenario, generated case, edge case

**Scenario Review**:
Write 中，每個 Feature 的 Scenario 寫入前的檢查：由另一個 agent 確認每個 step 都來自它引用的條目、Derived Scenario 確實必然推得、數值都有出處；它只挑錯，修正一律由寫 steps 的 agent 處理。比對的是 Gherkin 與 Aligned Brief 的條目，不是 Clarify 的 Grounding Review。
_Avoid_: Grounding review, verifier, validation

**Vocabulary Normalization**:
Write 中，全部 Feature 寫完之後統一用語的步驟：由一個 agent 整理出 Vocabulary，並指出哪些地方要把哪個說法換成標準用語；替換由程式逐字執行並記錄。
_Avoid_: Glossary, terminology alignment, normalizer

**Vocabulary**:
Vocabulary Normalization 的產出：每個概念一個標準用語，附上定義、要避免的說法與出處。標準用語優先取 Term、Actor、Domain Entity 的原名，其次是使用者在 Decision 中的用詞；與 Term 不同，它涵蓋 Gherkin 中出現的所有說法，不要求原文有定義。
_Avoid_: Glossary, dictionary, term list

## 評價

**Feedback**:
人對某個 Run 產出的評價：對某個條目的 verdict、漏掉的事實，或對整個 Run 的分數。附帶條目當下的原文快照，一經記錄就不修改，改變看法時以新的一筆取代或撤回。它不是 Stage 也不是 Run，記錄在被評價的那個 Run 的目錄中。
_Avoid_: Rating, review, annotation
