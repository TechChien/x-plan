#### acceptanceCriteria (id prefix AC)
Conditions or examples in the documents that decide whether a feature is done.
- `kind`:
  - `scenario`: the documents already describe it as a situation with a trigger and an outcome.
  - `example`: a concrete input/output example.
  - `hint`: a statement that implies a check, e.g. "取消後應退款至原付款方式".
- Fill `given` / `when` / `then` ONLY when the documents themselves are shaped that way. Otherwise fill `text` only.
- Never invent scenarios. Writing new scenarios is a later step, not this one.
- `featureId`: the FEAT id this criterion verifies.
