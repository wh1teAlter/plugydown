# Internal role invocation

Platform: opencode.

Delegate the same Role Brief to the named native Agent. Agent definition paths below are relative to this index.
OpenCode uses its default model. Read/glob/grep are enabled; Investigator may use bash, Recorder and Reflector may use edit. The webfetch and task tools are disabled. Bash can still write files or access the network; the Brief governs those actions. Edit covers writing and editing; the Brief narrows allowed paths.

Prefer a capable model for Investigator and Recorder when the host permits choosing one; Reflector may inherit. The Role Brief and Main Assistant remain the authority for allowed writes and final approval. Native tool settings do not enforce candidate-only filesystem access.

| Role | Definition | Model preference | Tool guidance (Claude names) |
| --- | --- | --- | --- |
| investigator | [investigator](../../agents/investigator.md) | capable | Read, Glob, Grep, Bash |
| recorder | [recorder](../../agents/recorder.md) | capable | Read, Glob, Grep, Write, Edit |
| reflector | [reflector](../../agents/reflector.md) | inherit | Read, Glob, Grep, Write |
