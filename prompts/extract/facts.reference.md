### Reference documents
A document with `role="reference"` is supporting material, such as a database schema, an API manual or a catalogue. A document without a `role` is a requirement document: it states what is to be built.
- The requirement documents set the scope. From a reference document, record only what the requirements need: the tables, columns, endpoints, fields and rules they use or that are needed to carry them out. Ignore the rest, even when it reads like a requirement.
- A reference document never adds an actor or a feature on its own. A system it describes that the requirements use (an external API, a database) is a dependency; the details the requirements need are business rules, constraints or domain entities.
- Guidance on how to read or use the documents themselves, such as which file to load first, is not a requirement.
- Raise an open question about reference material only when the requirements depend on it, for example when it is unclear which table to use or a needed object is marked deprecated.
- A document with `role="context"` is a requirement document that is extracted in another batch. It is shown only so you can judge relevance: never extract from it or cite it.
