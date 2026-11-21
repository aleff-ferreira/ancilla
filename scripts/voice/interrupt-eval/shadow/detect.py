"""Runs an open interruption detector (pipecat-ai/backchannel-detector, streaming ONNX) offline over the microphone and speaker
recordings that `run.mjs --dump` writes for its `:deaf` reference arm: the sound the call heard, with the assistant's own voice
going on underneath, exactly as the pilot and the baseline heard it. It is a comparison of the decision, not part of the call.

  python3 -E -P detect.py --model <backchannel-fp32.onnx> --dump <dump dir> --out <results dir> [--lang en]

What it computes for every recording (20 ms frames, 40 ms chunks, as the model card describes): the probability that the sound is
a floor-taking interruption (the card's `negative` plus `floor_take`) and that it is a backchannel (`continuer` plus
`assessment`), and from the first, for several thresholds, when a decision to stop the assistant would have been taken (the end
of the 40 ms chunk that holds the first frame at or above the threshold) and whether one was taken when it should not have been.

The model's `bot_state` input is built from the speaker recording by the model card's description (speaking; seconds since the
bot's onset, since its last pause of at least 200 ms and since it stopped, each clipped to 5 s and divided by 5; filler; three
zeros). The card does not say which index holds which field or how the fields are defined at the edges, so three encodings are run
and reported: the card's order as read here ("card"), the same with 0 instead of 1 for "seconds since stop" while the bot
speaks ("stop0"), and all zeros ("zeros"). The dependence on them is part of the result.
"""

import argparse
import glob
import json
import os
import sys

import numpy as np
import onnxruntime as ort

RATE = 16000
CHUNK = 640  # 40 ms
FRAME = 320  # 20 ms
THRESHOLDS = (0.5, 0.7, 0.9)
ACTIVE_DB = -54.0  # the speaker counts as speaking above this level, as everywhere else in the evaluation
PAUSE_FRAMES = 10  # a gap of 200 ms or more is a pause; a shorter one is inside the same stretch of speech
STATE_NAMES = ("audio_cache", "stem_cache", "block0_cache", "block1_cache", "block2_cache", "block3_cache", "gru_state")


def bot_state(spk, n_frames, first_audio_ms, mode):
    """[n_frames, 8] float32 for the 20 ms frames of the recording."""
    out = np.zeros((n_frames, 8), dtype=np.float32)
    if mode == "zeros":
        return out
    thr = 10 ** (ACTIVE_DB / 20)
    active = np.zeros(n_frames, dtype=bool)
    for f in range(n_frames):
        seg = spk[f * FRAME:(f + 1) * FRAME]
        if len(seg) > 0 and np.sqrt(np.mean(seg.astype(np.float64) ** 2)) >= thr:
            active[f] = True
    onset_f = None if first_audio_ms is None else int(first_audio_ms / 20)
    last_active = None
    run_start = onset_f  # when the bot last (re)started after a pause of 200 ms or more
    stopped_at = None
    for f in range(n_frames):
        if active[f]:
            if last_active is not None and f - last_active - 1 >= PAUSE_FRAMES:
                run_start = f
            if onset_f is None:
                onset_f = f
                run_start = f
            last_active = f
        speaking = last_active is not None and f - last_active <= PAUSE_FRAMES
        if not speaking and last_active is not None and stopped_at is None:
            stopped_at = last_active + 1
        if speaking:
            stopped_at = None
        clip = lambda seconds: min(max(seconds, 0.0), 5.0) / 5.0
        if speaking:
            out[f, 0] = 1.0
            out[f, 1] = clip(((f - onset_f) * 20) / 1000.0) if onset_f is not None else 0.0
            out[f, 2] = clip(((f - run_start) * 20) / 1000.0) if run_start is not None else 0.0
            out[f, 3] = 0.0 if mode == "stop0" else 1.0
        else:
            out[f, 1] = clip(((f - onset_f) * 20) / 1000.0) if onset_f is not None else 0.0
            out[f, 2] = clip(((f - run_start) * 20) / 1000.0) if run_start is not None else 0.0
            out[f, 3] = clip(((f - stopped_at) * 20) / 1000.0) if stopped_at is not None else 1.0
    return out


def run_model(session, mic, states_in):
    """Streams the whole recording; returns per-frame p_floor, p_backchannel and the chunk each frame belongs to."""
    n_chunks = int(np.ceil(len(mic) / CHUNK))
    padded = np.zeros(n_chunks * CHUNK, dtype=np.float32)
    padded[: len(mic)] = mic
    caches = {}
    for i in session.get_inputs():
        if i.name in STATE_NAMES:
            caches[i.name] = np.zeros([d if isinstance(d, int) else 1 for d in i.shape], dtype=np.float32)
    p_floor = np.zeros(n_chunks * 2, dtype=np.float32)
    p_back = np.zeros(n_chunks * 2, dtype=np.float32)
    for c in range(n_chunks):
        feed = {"chunk": padded[c * CHUNK:(c + 1) * CHUNK].reshape(1, CHUNK), "bot_state": states_in[2 * c:2 * c + 2].reshape(1, 2, 8)}
        feed.update(caches)
        outputs = session.run(None, feed)
        by_name = {o.name: v for o, v in zip(session.get_outputs(), outputs)}
        intent = by_name["intent"][0]  # [2, 5]: continuer, assessment, negative, floor_take, non_speech
        p_floor[2 * c:2 * c + 2] = intent[:, 2] + intent[:, 3]
        p_back[2 * c:2 * c + 2] = intent[:, 0] + intent[:, 1]
        for name in STATE_NAMES:
            caches[name] = by_name[name + "_out"]
    return p_floor, p_back


def first_detection(p_floor, threshold, start_ms, end_ms):
    """Time (ms, end of the 40 ms chunk) of the first frame at or above the threshold with its chunk ending in [start, end]."""
    for f in range(len(p_floor)):
        chunk_end = ((f // 2) + 1) * 40
        if chunk_end < start_ms:
            continue
        if chunk_end > end_ms:
            return None
        if p_floor[f] >= threshold:
            return chunk_end
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default=None)
    args = ap.parse_args()
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    os.makedirs(args.out, exist_ok=True)
    rows = []
    for meta_path in sorted(glob.glob(os.path.join(args.dump, "*.json"))):
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        if args.lang and meta["lang"] != args.lang:
            continue
        base = meta_path[: -len(".json")]
        mic = np.fromfile(base + ".mic.f32", dtype="<f4")
        spk = np.fromfile(base + ".spk.f32", dtype="<f4")
        n_frames = (int(np.ceil(len(mic) / CHUNK)) * 2)
        for mode in ("card", "stop0", "zeros"):
            states = bot_state(spk, n_frames, meta.get("firstAudioMs"), mode)
            p_floor, p_back = run_model(session, mic, states)
            onset = meta["onsetMs"]
            row = {"id": meta["id"], "kind": meta["kind"], "sub": meta["sub"], "lang": meta["lang"], "voice": meta["voice"], "echoDb": meta["echoDb"], "text": meta["text"], "mode": mode, "onsetMs": onset, "noPerson": meta["noPerson"]}
            # before the assistant has begun to speak the microphone may still hold the end of the person's own first turn, which is not
            # an interruption: a decision only counts as taken on the assistant's own echo from 100 ms after its voice begins
            first_audio = meta.get("firstAudioMs")
            guard_from = max(1000, (first_audio if first_audio is not None else 0) + 100)
            for thr in THRESHOLDS:
                # a decision before the person began (taken on the assistant's own echo) is a self-trigger; one after it is the decision
                early = first_detection(p_floor, thr, guard_from, onset - 40)
                after = first_detection(p_floor, thr, onset - 40, onset + 3000)
                row[f"selfTrigger@{thr}"] = early is not None
                row[f"detectMs@{thr}"] = None if after is None else after - onset
            row["maxFloorWindow"] = float(np.max(p_floor[int((onset - 40) / 20):int((onset + 3000) / 20)])) if len(p_floor) > 0 else None
            row["maxFloorBefore"] = float(np.max(p_floor[int(guard_from / 20):max(int(guard_from / 20) + 1, int((onset - 40) / 20))]))
            row["pfloor"] = [round(float(x), 3) for x in p_floor[int(max(0, onset - 200) / 20):int((onset + 1500) / 20)]]
            rows.append(row)
    with open(os.path.join(args.out, "shadow-rows.jsonl"), "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"{len(rows)} rows from {len(rows) // 3} recordings -> {os.path.join(args.out, 'shadow-rows.jsonl')}")


if __name__ == "__main__":
    sys.exit(main())
