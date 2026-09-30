# x-plan

x-plan 將使用者提供的需求文件轉換為 BDD（Gherkin）需求文件，作為 PM、R&D、QA 討論的共同基礎。

## 流程

**Run**:
一次 x-plan 執行，從一組 Source Document 出發，依序經過三個 Stage，每個 Stage 的產出都保存下來可供檢視與重跑。
_Avoid_: Job, session, task

**Stage**:
Run 中職責單一的一個步驟，依序為 Extract、Clarify、Write；每個 Stage 只讀取前一個 Stage 的產出。
_Avoid_: Phase, step

**Extract**:
第一個 Stage：從 Source Document 擷取需求資訊並產出 Requirement Brief，過程中不與使用者互動。
_Avoid_: Parse, ingest

**Clarify**:
第二個 Stage：以 Requirement Brief 為基礎，持續拷問使用者直到需求理解對齊。
_Avoid_: Grill, interview, Q&A

**Write**:
第三個 Stage：依據對齊後的需求寫出 Gherkin 需求文件。
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
原文未明寫、由模型推論而來的內容；唯一允許不附 Evidence 的條目，必須與有原文依據的事實分開存放。
_Avoid_: Guess, inference
