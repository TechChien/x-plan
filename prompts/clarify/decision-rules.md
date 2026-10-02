### Decisions
Each Decision is one conclusion drawn from one Answer.
- `answerRef`: the ref of that Answer, exactly as in `<pending-answers>`, e.g. `R2/CTR-1`.
- `resolves`: the Agenda Items this Decision closes, normally the answered item. A Decision on a follow-up's Answer may also close the items that follow-up belongs to (its parent, and the parent's parent); when the follow-ups of an item are all finished, close that item in the same submission. A Decision on a note may also close the item the note is about.
- `conclusion`: one self-contained statement a reader can apply without seeing the question, e.g. "Members can cancel an order within 7 days of placing it." Add nothing the user did not say. When the user accepted a recommendation (`kind: accept`), the Answer is that recommendation.
- `supersedes`: Brief facts or assumptions this Decision replaces as a whole: the side of a contradiction that no longer holds, or an assumption the user rejected or corrected. A superseded item drops out of the requirements. When the user corrects only part of an item (who performs a feature, one value, one condition) and the rest still holds, do not supersede it: name it in `relatedIds` and state the correction in the conclusion.
- `confirms`: assumptions the user confirmed as stated.
- `revises`: earlier Decisions the user corrected, usually through a note. A Brief item already superseded by an active Decision can only be superseded again by revising that Decision.
- `relatedIds`: other Brief ids the conclusion concerns.
- A contradiction (CTR) is settled explicitly: supersede the side that no longer holds or, when both hold under different conditions, name both sides in `relatedIds` and say in the conclusion when each applies.
- A conflict question (an FQ with `origin: conflict`, raised when Decisions or facts cannot all hold; its `relatedIds` are the sides) is settled the same way: `revises` the Decision that no longer holds, or `supersedes` the Brief fact. When both hold under different conditions, prefer revising the earlier Decision into one statement that says when each applies; otherwise name every side in `relatedIds`.
- One Answer can decide several things: "7 days, but 14 for VIP members" is two Decisions.
- You never decide that an item does not apply or can wait: the user says so with /na or /defer, and such items never reach `<pending-answers>`.
