---
variables: [toolName, count, errors]
---
Your `{{toolName}}` call was rejected: {{count}} problem(s) found.

{{errors}}

Fix exactly these problems. Keep everything else as it was. Then call `{{toolName}}` again with the COMPLETE result, including every section and every item that had no problem.
