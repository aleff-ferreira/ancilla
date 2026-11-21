The English half of the held-out plan (60 episodes), three arms on the same audio: the call as it was (setting off), the pilot, and
a reference call that never reacts (`:deaf`) whose microphone and speaker were dumped (not kept here: about 70 MB; run.mjs --dump
regenerates them) for the offline detector. Pilot commit 1d5de9d; the harness at the commit that adds this folder.
shard-*.jsonl: the raw lines of the two scored arms. shadow-rows.jsonl: the detector's per-frame floor probability around the
onset and its decisions, for three encodings of its `bot_state` input and three thresholds. shadow-summary.md: summarize.mjs over
both. load.txt: the machine's load average every 20 s.
Model: pipecat-ai/backchannel-detector at 4896f4774cdf1a9c5b581b0cd4a0c4000e8bb854 (BSD-2-Clause), backchannel-fp32.onnx
(3,869,783 bytes, sha256 3e5d47740e5f75211cc78c5df701be9afe7b76c4115144212a18598766909240), model.json; onnxruntime 1.28.0,
numpy 2.5.1, python3 -E -P (isolation with -I was not possible: the packages are in the user site).
