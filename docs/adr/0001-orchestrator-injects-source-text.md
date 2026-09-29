# 由 Orchestrator 注入原文，不讓 Agent 自行讀檔

Extract 階段的 Source Document 由 orchestrator 讀取、轉檔（pdf/docx → 文字）、加上原始行號後，以 `<document path>` 包裹注入 user message；Facts／Analysis agent 不開放任何 PI 內建工具（read/bash/grep 等），只有 `submit_*`。gpt-oss-120b 等級模型在多步 tool-use 上容易漏讀、重複讀或讀一半就作答，而由程式注入可保證模型看到的內容完全確定、可重現，且 Evidence 的行號能用程式回頭驗證。

## Consequences

- 輸入量受 context window 限制，因此需要 orchestrator 端的裝箱（bin packing）與大檔切段，而不是讓 agent 自己按需讀取。
- PI 的 agent loop 在此階段僅用於「交卷＋驗證錯誤回饋重試」，未來若改為 agent 自行讀檔，Evidence 驗證與裝箱邏輯都要重新設計。
