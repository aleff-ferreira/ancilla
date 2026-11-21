#!/usr/bin/env bash
# One command for the whole paired evaluation: a checkout of v0.30.0 next to this one (unless one is named), both built, the check
# that their engines agree, the held-out episodes run on the three arms in parallel shards, the report printed. About 35
# minutes on the machine of docs/voice-interrupt-evaluation.md, and the voice pack (see README.md). Close other heavy programs
# first: the engines run in real time, and a busy processor delays the recogniser the pilot waits for.
#
#   scripts/voice/interrupt-eval/reproduce.sh [out dir]
#
# ANCILLA_VOICE_RUNTIME / ANCILLA_VOICE_MODELS name the voice pack (default ~/voice-lab and ~/voice-lab/models),
# ANCILLA_BASELINE_DIR the checkout of v0.30.0 (default ../ancilla-v0.30.0, created when missing), ANCILLA_EVAL_SHARDS the
# number of parallel processes (default 3), ANCILLA_EVAL_SKIP_BUILD=1 to use checkouts that are already built.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVAL="$HERE/scripts/voice/interrupt-eval"
OUT="${1:-$EVAL/results/$(date +%Y%m%d)}"
BASE="${ANCILLA_BASELINE_DIR:-$HERE/../ancilla-v0.30.0}"
RUNTIME="${ANCILLA_VOICE_RUNTIME:-$HOME/voice-lab}"
MODELS="${ANCILLA_VOICE_MODELS:-$RUNTIME/models}"
SHARDS="${ANCILLA_EVAL_SHARDS:-3}"
export LD_LIBRARY_PATH="$RUNTIME/node_modules/sherpa-onnx-linux-x64:${LD_LIBRARY_PATH:-}"
export TZ=UTC
mkdir -p "$OUT"

if [ ! -d "$BASE" ]; then
  git -C "$HERE" worktree add --detach "$BASE" v0.30.0
fi
if [ -z "${ANCILLA_EVAL_SKIP_BUILD:-}" ]; then
  for root in "$BASE" "$HERE"; do
    (cd "$root" && npm ci --silent && npm run build --silent --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server)
  done
fi

echo "baseline $(git -C "$BASE" rev-parse HEAD), pilot $(git -C "$HERE" rev-parse HEAD)" | tee "$OUT/revisions.txt"
node --no-warnings "$EVAL/engines-equal.mjs" --baseline "$BASE" --pilot "$HERE" --runtime "$RUNTIME" --models "$MODELS" | tee "$OUT/engines-equal.txt"

pids=()
for ((i = 0; i < SHARDS; i++)); do
  node --no-warnings "$EVAL/run.mjs" --split heldout --kinds stop,correction,control,ordinary \
    --arm "baseline=$BASE" --arm "pilot=$HERE:pilot" --arm "tuned=$BASE:tuned" \
    --runtime "$RUNTIME" --models "$MODELS" --shard "$i/$SHARDS" --out "$OUT/shard-$i.jsonl" > "$OUT/shard-$i.log" 2>&1 &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
[ "$status" = 0 ] || { echo "a shard failed: see $OUT/shard-*.log" >&2; exit 1; }
node "$EVAL/report.mjs" "$OUT"/shard-*.jsonl --failures pilot | tee "$OUT/report.txt"
