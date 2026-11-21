First held-out run: commit 572b0f0 (the pilot before the task-hold fix), three shards, v0.30.0 baseline 1dcaa1f.
shard-*.jsonl are the raw lines (one per episode and arm); report.txt is report.mjs over them (its gate 4 line does not count the
tasks the pilot started after a drop message: see failure-causes.txt and section 5.4 of docs/voice-interrupt-evaluation.md);
load.txt is the machine's load average every 20 s during the run; ordinary-quiet.jsonl is a repeat of the ordinary turns alone.
