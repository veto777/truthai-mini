#!/usr/bin/env python3
"""Own implementation of MLC's q4f16_1 group quantization (reference: mlc_llm/quantization/group_quantization.py GroupQuantize:
group_size 32, int4 in uint32 storage (8 per word, least-significant nibble first), symmetric: scale = max|w|/7 in fp16,
q = clip(round(w/scale + 7), 0, 14); embeddings quantized, norms kept fp16, lm_head tied). The official
the per-size mlc-ai/Qwen3-<size>-<quant>-MLC ndarray-cache.json is used as the exact TEMPLATE for names, shapes, dtypes, formats and shard
boundaries, so the prebuilt WebLLM library loads the result like the stock model. Why: this nightly's converter segfaults in the
TVM printer.
  q4f16_1_convert.py <hf_dir> <stock_ndarray_cache.json> <out_dir>"""
import sys, os, json, hashlib, time
if len(sys.argv) < 4 or sys.argv[1] in ("-h","--help"):
    sys.exit("usage: q4f16_1_convert.py <hf_dir> <stock_ndarray_cache.json> <out_dir> [f32]")
import numpy as np
from safetensors import safe_open

hf, tmpl, out = sys.argv[1], sys.argv[2], sys.argv[3]; os.makedirs(out, exist_ok=True)
MODEL_DTYPE = np.float32 if (len(sys.argv) > 4 and sys.argv[4] == "f32") else np.float16   # q4f32_1: scales and norms in float32
idx = json.load(open(os.path.join(hf, "model.safetensors.index.json")))["weight_map"]
handles = {}
def W(name):
    f = idx[name]
    if f not in handles: handles[f] = safe_open(os.path.join(hf, f), framework="np")
    return handles[f].get_tensor(name)
GS, MAXI = 32, 7
def to_bf16_bytes(a32):
    """float32 -> bf16 (round-to-nearest-even) as uint16 words: the 'f32-to-bf16' storage format of MLC/tvmjs for float32 params."""
    u = np.ascontiguousarray(a32, dtype=np.float32).view(np.uint32); r = ((u >> 16) & 1) + 0x7FFF; return ((u + r) >> 16).astype(np.uint16)
def bf16_round(a32):
    return (to_bf16_bytes(a32).astype(np.uint32) << 16).view(np.float32)
def quant(w32, scale_dtype):
    w = w32.astype(MODEL_DTYPE)                      # the loader casts to the model dtype before quantizing
    n, k = w.shape; assert k % GS == 0, (n, k)
    g = w.reshape(n, k // GS, GS)
    max_abs = np.abs(g).max(axis=2).astype(MODEL_DTYPE)
    scale = (max_abs / MODEL_DTYPE(MAXI)).astype(scale_dtype)
    if scale_dtype == np.float32: scale = bf16_round(scale)   # float32 params are STORED as bf16 (format f32-to-bf16): quantize against the value the runtime will see
    safe = np.where(scale == 0, np.asarray(1, dtype=scale_dtype), scale)
    q = np.rint(g.astype(np.float32) / safe.astype(np.float32)[:, :, None] + MAXI)
    q = np.clip(q, 0, 2 * MAXI).astype(np.uint32).reshape(n, k)
    q = np.where(np.repeat(scale == 0, GS, axis=1), np.uint32(MAXI), q)
    packed = np.zeros((n, k // 8), dtype=np.uint32)
    for j in range(8): packed |= q[:, j::8] << np.uint32(4 * j)
    return packed, scale
def tensor_for(name, dtype):
    base = name.rsplit(".", 1)[0]; kind = name.rsplit(".", 1)[1]
    if kind in ("q_weight", "q_scale"):
        if base == "model.embed_tokens": w = W("model.embed_tokens.weight")
        elif base.endswith("self_attn.c_attn"):
            p = base[: -len("c_attn")]; w = np.concatenate([W(p + "q_proj.weight"), W(p + "k_proj.weight"), W(p + "v_proj.weight")], axis=0)
        elif base.endswith("mlp.gate_up_proj"):
            p = base[: -len("gate_up_proj")]; w = np.concatenate([W(p + "gate_proj.weight"), W(p + "up_proj.weight")], axis=0)
        else: w = W(base + ".weight")
        qw, sc = quant(w, np.dtype(dtype) if kind == "q_scale" else MODEL_DTYPE); return qw if kind == "q_weight" else sc
    return W(name).astype(dtype)                    # norms: template dtype
T = json.load(open(tmpl)); recs_out = []; t0 = time.time(); total = 0
for si, rec in enumerate(T["records"]):
    buf = bytearray(); prs = []
    for p in rec["records"]:
        a = tensor_for(p["name"], p["dtype"]); assert list(a.shape) == p["shape"], (p["name"], a.shape, p["shape"]); assert str(a.dtype) == p["dtype"], (p["name"], a.dtype, p["dtype"])
        b = to_bf16_bytes(a).tobytes() if (p["dtype"] == "float32" and p["format"] == "f32-to-bf16") else a.tobytes()
        assert len(b) == p["nbytes"], (p["name"], len(b), p["nbytes"])
        prs.append({"name": p["name"], "shape": p["shape"], "dtype": p["dtype"], "format": p["format"], "nbytes": len(b), "byteOffset": len(buf)}); buf += b
    open(os.path.join(out, rec["dataPath"]), "wb").write(buf)
    recs_out.append({"dataPath": rec["dataPath"], "format": rec["format"], "nbytes": len(buf), "records": prs, "md5sum": hashlib.md5(buf).hexdigest()}); total += len(buf)
    print(f"shard {si+1}/{len(T['records'])} {rec['dataPath']} {len(buf)/1e6:.1f} MB  t={time.time()-t0:.0f}s", flush=True)
json.dump({"metadata": T["metadata"], "records": recs_out}, open(os.path.join(out, "ndarray-cache.json"), "w"), indent=1)
print("DONE", len(recs_out), "shards", total, "bytes", f"{time.time()-t0:.0f}s")
