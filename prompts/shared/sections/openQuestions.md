#### openQuestions (id prefix OQ)
Points that are ambiguous, missing, marked TBD / 待確認, or cannot be decided from the documents.
- Example: question "已出貨的訂單能否取消？", reason "文件只說可取消訂單，未說明出貨後的狀況".
- `reason`: why the documents do not settle it.
- `relatedIds`: ids of the items the question affects.
- `severity`: blocking = a behaviour cannot be specified without the answer; high / medium / low otherwise.
- `evidence`: where the ambiguity appears, if it appears somewhere; may be empty.
