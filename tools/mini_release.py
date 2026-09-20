#!/usr/bin/env python3
"""truthcoder-mini release bundler (release packaging). Produces, for each artefact directory:
  release/<tag>/<artefact>/…files…, MANIFEST.json (sha256 + bytes per file, lineage, gates), MANIFEST.json.sig (OpenSSH
  ed25519 signature — verifiable with `ssh-keygen -Y verify` on any machine with OpenSSH), <artefact>.torrent + magnet
  (BitTorrent v1, stdlib bencode), the IPFS CID (kubo `ipfs add --only-hash`, CIDv1), and a README with the verify commands.
  MINI_RELEASE_SEQ=<n> MINI_PROVENANCE='{"<artefact>": {"model": "...", "hf_commit": "..."}}' mini_release.py <tag> <signing_key> <identity> <artefact_dir>... (key needs <key>, <key>.pub, <key>.pem, <key>.pub.hex)"""
import sys, os, json, hashlib, time, subprocess, shutil, urllib.parse
if len(sys.argv) < 5 or sys.argv[1] in ("-h","--help"):
    sys.exit("usage: MINI_RELEASE_SEQ=<n> MINI_PROVENANCE=<json> MINI_WWW=<dir> mini_release.py <tag> <key> <identity> <artefact_dir>...")
tag, key, ident, dirs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
# Provenance is REQUIRED per artefact: MINI_PROVENANCE = JSON {"<artefact_basename>": {"model": "...", "hf_commit": "...", "license": "..."}}
PROV = json.loads(os.environ.get("MINI_PROVENANCE") or "{}")
for _d in dirs:
    _n = os.path.basename(_d.rstrip("/"))
    if _n not in PROV or not PROV[_n].get("model") or not PROV[_n].get("hf_commit"):
        raise SystemExit(f"MINI_PROVENANCE missing model/hf_commit for artefact {_n!r} — refusing to assert provenance it was not given")
def _converter(artefact):
    # artefact like qwen3-0.6B-abl-q4f16_1 -> size 0.6B, quant q4f16_1; the template is per-size, never hardcoded 4B
    import re as _re
    m=_re.search(r"qwen3-([0-9.]+[bB])-abl-(q4f[0-9]+_1)", artefact)
    size,quant=(m.group(1)[:-1]+m.group(1)[-1].upper(), m.group(2)) if m else ("?","?")   # canonical caps: 4b->4B
    return f"tools/q4f16_1_convert.py (own GroupQuantize implementation; MLC template mlc-ai/Qwen3-{size}-{quant}-MLC)"
SEQ = int(os.environ.get("MINI_RELEASE_SEQ") or 0)
if SEQ < 1: raise SystemExit("MINI_RELEASE_SEQ (integer >= 1, strictly increasing per release) is required — the client refuses rollbacks by this number")
REL = os.path.join(os.environ.get("MINI_RELEASE_DIR","release"), tag); os.makedirs(REL, exist_ok=True)
IPFS = os.environ.get("MINI_IPFS_BIN", "")  # set to your kubo `ipfs` binary to embed CIDs; empty = skip (cid:"")
def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
def bencode(o):
    if isinstance(o, int): return b"i%de" % o
    if isinstance(o, bytes): return b"%d:%s" % (len(o), o)
    if isinstance(o, str): return bencode(o.encode())
    if isinstance(o, list): return b"l" + b"".join(bencode(x) for x in o) + b"e"
    if isinstance(o, dict): return b"d" + b"".join(bencode(k) + bencode(o[k]) for k in sorted(o)) + b"e"
    raise TypeError(o)
def make_torrent(dirpath, name, out, piece_len=4 << 20):
    files, pieces, buf = [], [], b""
    for root, _, fs in os.walk(dirpath):
        for fn in sorted(fs):
            p = os.path.join(root, fn); rel = os.path.relpath(p, dirpath).split(os.sep); files.append({"length": os.path.getsize(p), "path": rel})
            with open(p, "rb") as f:
                while True:
                    chunk = f.read(piece_len - len(buf))
                    if not chunk: break
                    buf += chunk
                    if len(buf) == piece_len: pieces.append(hashlib.sha1(buf).digest()); buf = b""
    if buf: pieces.append(hashlib.sha1(buf).digest())
    info = {"name": name, "piece length": piece_len, "pieces": b"".join(pieces), "files": files}
    ih = hashlib.sha1(bencode(info)).hexdigest()
    t = {"announce": "udp://tracker.opentrackr.org:1337/announce", "announce-list": [["udp://tracker.opentrackr.org:1337/announce"], ["udp://open.stealth.si:80/announce"]], "created by": "truthcoder-mini release", "creation date": int(time.time()), "info": info}
    open(out, "wb").write(bencode(t)); return ih, sum(f["length"] for f in files)
# The probe binding: hash the SHIPPED probe files so the value in each signed manifest equals what the client
# will recompute in the browser. MINI_WWW points at the deployed www/ (default: ./www).
_WWW = os.environ.get("MINI_WWW", "www")
def _wsha(name):
    p = os.path.join(_WWW, name)
    return sha256(p) if os.path.exists(p) else None
_PROBE_SHA = _wsha("probe_constants.json"); _FIX_SHA = _wsha("fixtures.json")
if _PROBE_SHA is None or _FIX_SHA is None:
    raise SystemExit(f"MINI_WWW={_WWW!r} does not contain probe_constants.json AND fixtures.json — refusing to emit a release without the probe bindings the client requires")
out_summary = {"tag": tag, "release_sequence": SEQ, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "artefacts": {}}
try: out_summary["release_pubkey_ed25519_hex"] = open(key + ".pub.hex").read().strip()
except FileNotFoundError: raise SystemExit(f"missing {key}.pub.hex — the client refuses a RELEASE.json without the pinned public key")
for d in dirs:
    name = os.path.basename(d.rstrip("/")); dst = os.path.join(REL, name)
    if os.path.exists(dst): shutil.rmtree(dst)
    shutil.copytree(d, dst)
    files = {fn: {"sha256": sha256(os.path.join(dst, fn)), "bytes": os.path.getsize(os.path.join(dst, fn))} for fn in sorted(os.listdir(dst)) if os.path.isfile(os.path.join(dst, fn)) and not fn.startswith("MANIFEST.json")}
    man = {"artefact": name, "tag": tag, "model": PROV[name]["model"], "hf_commit": PROV[name]["hf_commit"], "license": PROV[name].get("license", "apache-2.0"),
           "note": os.environ.get("MINI_RELEASE_NOTE", "stock abliterated Qwen3 weights, quantized for WebGPU"), "quantization": "q4f32_1" if "f32" in name else "q4f16_1",
           "converter": _converter(name), "gates": json.loads(os.environ.get("MINI_RELEASE_GATES", "{}")),
           "release_sequence": SEQ, "min_client_version": "0.1", "probe_constants_sha256": _PROBE_SHA, "fixtures_sha256": _FIX_SHA, "files": files, "total_bytes": sum(v["bytes"] for v in files.values()), "created": out_summary["created"]}
    mp = os.path.join(dst, "MANIFEST.json"); json.dump(man, open(mp, "w"), indent=1)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", key, "-n", "truthcoder-mini", mp], check=True, capture_output=True)
    # second signature the CLIENT verifies in-browser (WebCrypto Ed25519): raw 64-byte Ed25519 over the exact MANIFEST.json bytes
    pem = key + ".pem"
    if not os.path.exists(pem):
        raise SystemExit(f"missing {pem} — the raw ed25519 signature (what the browser verifies) cannot be produced; refusing to emit an unverifiable release")
    subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", pem, "-rawin", "-in", mp, "-out", mp + ".ed25519"], check=True)
    pubpem = subprocess.run(["openssl", "pkey", "-in", pem, "-pubout"], check=True, capture_output=True).stdout
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".pem") as tf:
        tf.write(pubpem); tf.flush()
        subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", tf.name, "-rawin", "-in", mp, "-sigfile", mp + ".ed25519"], check=True, capture_output=True)
    # AND verify against the ADVERTISED public key (the one that goes into RELEASE.json and the client pin):
    # a mismatched .pub.hex would otherwise publish a key the signature does not validate under.
    adv_hex = open(key + ".pub.hex").read().strip()
    adv_der = bytes.fromhex("302a300506032b6570032100") + bytes.fromhex(adv_hex)   # SPKI prefix + raw ed25519
    with tempfile.NamedTemporaryFile(suffix=".der") as af:
        af.write(adv_der); af.flush()
        r = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER", "-inkey", af.name, "-rawin", "-in", mp, "-sigfile", mp + ".ed25519"], capture_output=True)
        if r.returncode != 0:
            raise SystemExit(f"{key}.pub.hex does not match the signing key — refusing to publish a release whose advertised key cannot verify it")
    tf_out = os.path.join(dst, name + ".torrent")
    ih, total = make_torrent(dst, name, tf_out)
    magnet = "magnet:?xt=urn:btih:" + ih + "&dn=" + urllib.parse.quote(name)
    cid = ""
    if os.path.exists(IPFS):
        r = subprocess.run([IPFS, "add", "-r", "-Q", "--only-hash", "--cid-version=1", dst], capture_output=True, text=True); cid = r.stdout.strip()
    out_summary["artefacts"][name] = {"manifest_sha256": sha256(mp), "infohash": ih, "magnet": magnet, "cid": cid, "bytes": total}
    print(name, "bytes", total, "infohash", ih, "cid", cid)
open(os.path.join(REL, "RELEASE.json"), "w").write(json.dumps(out_summary, indent=1))
pub = open(key + ".pub").read().strip()
open(os.path.join(REL, "allowed_signers"), "w").write(f"{ident} {pub}\n")
open(os.path.join(REL, "README.md"), "w").write(f"""# truthai-mini release `{tag}`
Verify any artefact on any machine with OpenSSH ≥ 8.2:
```
ssh-keygen -Y verify -f allowed_signers -I {ident} -n truthcoder-mini -s <artefact>/MANIFEST.json.sig < <artefact>/MANIFEST.json
sha256sum -c <(python3 -c "import json;m=json.load(open('<artefact>/MANIFEST.json'));[print(v['sha256'],' ','<artefact>/'+k) for k,v in m['files'].items()]")
```
Get it: the `.torrent`/magnet in RELEASE.json (BitTorrent), or the CID in RELEASE.json (IPFS: `ipfs get <cid>`), or any listing mirror — then verify as above. The signature binds the manifest; the manifest binds every byte.
""")
print("release at", REL)
