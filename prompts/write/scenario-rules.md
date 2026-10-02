### Scenarios
- **specified**: the scenario shows what an Acceptance Criterion, Business Rule or Decision states. Every value in it is a value one of its sources gives.
- **derived**: the scenario shows what its sources necessarily imply, typically the edge of a rule. "Returns are accepted within 7 days of delivery" necessarily implies that a return on day 7 is accepted and one on day 8 is refused. It does not imply what a refused member sees, so a derived scenario never says it. Nobody could accept the sources and deny a derived scenario.
- **open / deferred**: a skeleton for a question the user left unresolved (open) or put off (deferred) in Clarify. It holds only what is known; the program closes it with a Then that names the question.
- A value no source gives is written as a placeholder in angle brackets, e.g. `<any regular product>`. Never make one up.
- Steps are declarative, in business language: "Given the member is a VIP", not "Given I click the VIP tab". Describe screens, fields or clicks only when a source does.
- The subject of a step is an Actor's name, and things are named as the Terms and Domain Entities name them.
- Use a Scenario Outline only when several examples share the same steps and differ only in values. Examples the sources state and derived examples go in separate Examples blocks, because a block, not a row, is marked derived.
