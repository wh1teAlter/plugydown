# Internal role invocation

Platform: cursor.

Delegate the same Role Brief to the named native Agent. Agent definition paths below are relative to this index.
Cursor uses its default model and tools. Model preferences and the listed tool names are guidance; this Plugin does not enforce per-role tool grants.

Prefer a capable model for Investigator and Recorder when the host permits choosing one; Reflector may inherit. The Role Brief and Main Assistant remain the authority for allowed writes and final approval. Native tool settings do not enforce candidate-only filesystem access.

| Role | Definition | Model preference | Tool guidance (Claude names) |
| --- | --- | --- | --- |
| investigator | [investigator](../../agents/investigator.md) | capable | Read, Glob, Grep, Bash |
| recorder | [recorder](../../agents/recorder.md) | capable | Read, Glob, Grep, Write, Edit |
| reflector | [reflector](../../agents/reflector.md) | inherit | Read, Glob, Grep, Write |
