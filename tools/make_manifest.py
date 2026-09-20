#!/usr/bin/env python3
"""manifest.json for truthai-mini: sha256 of every executable/config input and every model shard, plus provenance."""
import hashlib, json, os, sys, glob, subprocess, time
www = sys.argv[1] if (len(sys.argv) > 1 and sys.argv[1] not in ("-h","--help")) else sys.exit("usage: MINI_MODEL_NAME=<m> MINI_VARIANTS=<json> make_manifest.py <www_dir>")
# variants are deployment-specific: override with MINI_VARIANTS='{"<quant>": ["models/<dir>", "<lib>.wasm", <vram_MB>], ...}'
if not os.environ.get("MINI_VARIANTS"):
    sys.exit("MINI_VARIANTS is required: JSON {\"<quant>\": [\"models/<dir>\", \"<lib>.wasm\", <vram_MB>], ...} — no default, so a manifest can never silently describe the wrong model")
VARIANTS = {k: tuple(v) for k, v in json.loads(os.environ["MINI_VARIANTS"]).items()}
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
files = {}
for rel in ["app/index.html", "app/client.js", "app/boot.js", "app/manifest.webmanifest", "probe.js", "sw.js", "probe_constants.json", "fixtures.json"] + sorted("vendor/"+f for f in (os.listdir(os.path.join(www,"vendor")) if os.path.isdir(os.path.join(www,"vendor")) else [])):
    p = os.path.join(www, rel)
    if os.path.exists(p): files[rel] = sha(p)
shards = {}; variants = {}
for vn, (md_rel, lib, vram) in VARIANTS.items():
    md = os.path.join(www, md_rel); vs = {}
    for p in sorted(glob.glob(os.path.join(md, "*"))):
        if os.path.isfile(p): vs[os.path.basename(p)] = {"sha256": sha(p), "bytes": os.path.getsize(p)}
    if vs: variants[vn] = {"model_dir": os.path.basename(md_rel), "model_lib": lib, "vram_required_MB": vram, "shard_count": len(vs), "shard_bytes": sum(v["bytes"] for v in vs.values()), "shards": vs}
    shards.update({vn + "/" + k: v for k, v in vs.items()})
consts = json.load(open(os.path.join(www, "probe_constants.json")))
_pc = os.path.join(www, "probe_constants.json"); _fx = os.path.join(www, "fixtures.json")
m = {"step": "truthai-mini", "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model_name": (os.environ.get("MINI_MODEL_NAME") or sys.exit("MINI_MODEL_NAME is required")), "hf_commit": os.environ.get("MINI_HF_COMMIT", ""), "license": "apache-2.0",
     "quantization": "q4f16_1 + q4f32_1", "variants": variants, "model_lib_version": "v0_2_84/base", "webllm_version": "0.2.85",
     "mlc_llm_version": os.environ.get("MLC_LLM_VERSION", "0.1.dev0 (nightly-cpu)"), "conversion_seconds": os.environ.get("CONVERT_SECONDS"), "probe_constants_sha256": sha(_pc), "fixtures_sha256": (sha(_fx) if os.path.exists(_fx) else None),
     "files": files, "shards": shards, "shard_count": len(shards), "shard_bytes": sum(v["bytes"] for v in shards.values())}
canon = json.dumps({k: v for k, v in m.items() if k != "manifest_sha256"}, sort_keys=True).encode()
m["manifest_sha256"] = hashlib.sha256(canon).hexdigest()
json.dump(m, open(os.path.join(www, "manifest.json"), "w"), indent=1); print("manifest", m["manifest_sha256"][:16], "files", len(files), "shards", len(shards), "bytes", m["shard_bytes"])
