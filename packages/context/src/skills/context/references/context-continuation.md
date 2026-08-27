# Compact continuation

`PLUGYDOWN_CONTEXT_STATE` is the compact state block for one active task. It records the
active goal and next action, selected Domain and document IDs, facts already loaded,
fingerprints and freshness, user decisions and scope, changed files, validation state, and
unresolved risks.

When the state is present and relevant fingerprints have not changed, continue the task
directly after compaction. Do not repeat cold-start reads. If the state is missing or stale,
the task changed, a new Domain is needed, or code and knowledge conflict, perform a targeted
refresh through the Runtime frontier rather than a wholesale reload.

Hooks are fail-open and never write `context/meta.json` or any other formal knowledge file.
