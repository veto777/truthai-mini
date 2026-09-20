#!/usr/bin/env bash
# Build a phone-sized TruthCoder-mini artefact end to end, same proven path as the 4B:
#   abliterated base (HF) -> official MLC ndarray-cache as the template -> our own q4f16_1/q4f32_1 converter -> assemble -> verify.
# Why: iOS Safari caps per-tab memory far below the 4B build, so phones cannot run it at any setting (seen repeatedly on iOS).
#   build_mini.sh <hf_repo> <short>      e.g. build_mini.sh mlabonne/Qwen3-0.6B-abliterated 0.6B
set -euo pipefail
[ $# -lt 2 ] && { echo "usage: build_mini.sh <repo> <short> (needs MINI_EDGE_DIR)"; exit 1; }
E=${MINI_EDGE_DIR:-.}; P=$E/venv-cu/bin/python; REPO="$1"; SHORT="$2"; cd "$E"
HF="$E/hf-$SHORT"; say(){ echo "$(date -u +%H:%M:%S) $*"; }
say "download $REPO -> $HF"
$P - "$REPO" "$HF" <<'PY'
import sys
from huggingface_hub import snapshot_download
p=snapshot_download(sys.argv[1], local_dir=sys.argv[2],
    allow_patterns=["*.json","*.safetensors","*.txt","tokenizer*","merges*","vocab*"])
print("downloaded to", p)
PY
for V in q4f16_1 q4f32_1; do
  T="$E/tmpl-$SHORT-$V.json"
  say "template for $V"
  curl -sL -m 300 -o "$T" "https://huggingface.co/mlc-ai/Qwen3-$SHORT-$V-MLC/resolve/main/ndarray-cache.json"
  head -c 60 "$T" | grep -q '{' || { echo "template fetch failed for $V"; exit 1; }
  OUT="$E/out/qwen3-$SHORT-abl-$V"; rm -rf "$OUT"
  say "convert -> $OUT"
  if [ "$V" = q4f32_1 ]; then $P tools/q4f16_1_convert.py "$HF" "$T" "$OUT" f32; else $P tools/q4f16_1_convert.py "$HF" "$T" "$OUT"; fi
  say "assemble $OUT"
  CFG=$([ "$V" = q4f32_1 ] && echo stock-mlc-chat-config-f32.json || echo stock-mlc-chat-config.json)
  $P tools/assemble_model_dir.py "$HF" "$CFG" "$OUT" >/dev/null
  # tensor-cache.json declares the shard count; copying the 4B's made the engine chase 74 shards of a 9- or 30-shard model (2026-09-16, twice)
  curl -sL -m 180 -o "$OUT/tensor-cache.json" "https://huggingface.co/mlc-ai/Qwen3-$SHORT-$V-MLC/resolve/main/tensor-cache.json"
  $P -c "
import json,sys
t=json.load(open('$OUT/tensor-cache.json')); r=t.get('records', t if isinstance(t,list) else [])
n=json.load(open('$OUT/ndarray-cache.json'))
assert len(r)==len(n['records']), 'tensor-cache %d != ndarray-cache %d' % (len(r), len(n['records']))
print('  tensor-cache records:', len(r))
"
  du -sh "$OUT" | sed "s|^|  size: |"
done
say "BUILD_DONE $SHORT"
