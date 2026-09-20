# truthai-mini

**An AI that runs entirely in your browser. No account. No server seeing your words. No filter deciding what you may ask.**

Try it now: **https://truthaimini.com** → launches the app at [mini.truthcoder.com/app](https://mini.truthcoder.com/app/)

## What it is

**Current releases serve stock abliterated Qwen3 weights** — honest baseline, clearly labelled in each signed manifest; TruthAi-trained student models will ship as future signed releases. truthai-mini loads an open-weight language model (Qwen3, abliterated builds by [mlabonne](https://huggingface.co/mlabonne), Apache-2.0) into your browser with [WebLLM](https://github.com/mlc-ai/web-llm)/WebGPU and runs it **on your device**. The model downloads once and is cached by your browser; your conversation never leaves your machine. (A service worker for full offline page loads is on the roadmap — today the page itself still needs the network on first navigation.)

Three sizes, picked automatically by a device capability probe:

| build | download | for |
|---|---|---|
| 4B  | ~2.3 GB | desktops / laptops with a real GPU |
| 1.7B | ~940 MB | phones (default on mobile) |
| 0.6B | ~340 MB | last-resort fallback (`?size=0.6B`) |

## Why trust the download — signed releases

Every release is signed with Ed25519. The client pins the release public key — hardcoded in `www/app/client.js` as `PINNED_PUBKEY_HEX` and published in `keys/release_ed25519.pub.hex`, fetches `RELEASE.json` + `MANIFEST.json`, verifies the signature **on your device**, then hash-checks every shard against the manifest and writes the verified bytes into the Cache API entries the runtime loads from. (Exact scope of what is and isn't re-verified at load time is in SECURITY.md — the honest short version: manifest and shards are verified before load; whether the runtime re-reads each file from that cache versus re-fetching from the same verified origin is not independently re-checked.) A tampered mirror, CDN, IPFS pin or torrent of the release fails verification and will not load. The release signature covers the model release; the WebGPU runtime (`www/vendor/web-llm.js` and the compiled `.wasm`) is delivered by the origin over TLS and is not part of that signature. (Scope: the signature covers the release bytes; the page itself comes from the HTTPS origin — see SECURITY.md.) Running needs WebGPU (Chrome/Edge 113+, Safari 26+, Firefox 141+). Signature verification needs WebCrypto Ed25519 (Chrome/Edge 137+, Safari 17+, Firefox 129+) — a browser without it is refused, not silently trusted.

- `www/` — the deployable site: `www/app/` (the client — vanilla JS, no build step, no dependencies, no telemetry), the device probe, its constants and fixtures
- `serve.js` — minimal static server for self-hosting (MIME, Range requests, COOP/COEP)
- `tools/` — release tooling: quantize/convert (`q4f16_1_convert.py`), manifest builder, release signer
- `keys/` — the release-signing **public** key (the private half never leaves the signing machine)

## Self-host

```bash
node serve.js            # serves ./www on :8080 (open /app/ — the bare root redirects there)
# the repo ships www/app/, www/probe.js, www/probe_constants.json, www/fixtures.json, www/sw.js.
# add a release to complete it:
#   www/models/<dir>/resolve/main/…   (converted model — the runtime resolves this HF-style path; see tools/)
#   www/release/<tag>/  (RELEASE.json + per-artefact MANIFEST.json, MANIFEST.json.ed25519)
#   www/vendor/         (web-llm.js + the model's compiled webgpu.wasm)
# then point RELEASE_TAGS in www/app/client.js at your tag (the client pins tags deliberately —
# a serving host must not be able to steer clients to a different release).
```

Any static host works (the client is plain files) — it needs HTTPS (WebGPU requirement), Range request support for the shards, and COOP/COEP headers. The shipped serve.js sends a CSP of `script-src 'self' 'wasm-unsafe-eval'`; the page has no inline scripts (styles are inline, so style-src allows 'unsafe-inline'), so it loads cleanly under it.

## Build a release yourself

The pipeline, in order. Prerequisites: a Python env with `torch` + `safetensors`, the HF checkpoint on
disk, a stock MLC cache template for the same architecture (the converter reads its headers), and your
Ed25519 signing key present in all four forms: `<key>` (OpenSSH private), `<key>.pub`, `<key>.pem`
(PKCS#8, for the raw signature the browser verifies), `<key>.pub.hex` (raw 32-byte public key, hex).
Each script prints its exact usage when run without arguments; the release step **fails** rather than
emit anything unverifiable or with unstated provenance:

```bash
python3 tools/q4f16_1_convert.py            # prints usage; HF weights -> q4f16_1 shards (own GroupQuantize impl)
python3 tools/assemble_model_dir.py         # prints usage; shards + config -> a servable model dir
python3 tools/make_manifest.py www          # hashes the app + vendor files it finds under www/
MINI_RELEASE_SEQ=2 \
MINI_PROVENANCE='{"my-model-q4f16_1": {"model": "org/name", "hf_commit": "<sha>"}}' \
python3 tools/mini_release.py <tag> /path/to/<key> <identity> <model_dir>...
```

Sign with your own Ed25519 key and pin your own pubkey in the client — the trust model is yours to own.

## Privacy

- Prompts, answers, chats: stored in your browser's localStorage only. Nothing is transmitted.
- Fonts are self-hosted (www/app/fonts/, SIL OFL 1.1). The application itself makes no third-party request and sends no telemetry — no analytics script, no beacon, no fetch off-device. (If you serve the site through a CDN like Cloudflare, that CDN's edge may set standard infrastructure headers such as NEL; self-host on a plain static server to avoid even that.)
- A grounding feature is **in development** (not in this release): it will send only the question text to a retrieval server to fetch reference passages, will say so in the UI, and will be off-switchable.

## The pre-chat probe

Before the chat box unlocks, the client sends the model 8 fixed prompts and scans each reply, within the first
300 characters, for any of 28 refusal markers ("I can't", "I'm not able to", etc.). This is a coarse check, not a
guarantee: it detects a model that *refuses*, which is the signal that a censored build was loaded under an
uncensored label; it does not grade answer quality or prove uncensoredness, and a determined nonsense answer can
pass it. It is **not** a filter on what you may ask — it never inspects your prompts and never blocks your answers.
The 8 prompts and 6 classifier fixtures ship in `www/probe_constants.json` and `www/fixtures.json`, and both are
hash-checked against the signed manifest (`probe_constants_sha256`, `fixtures_sha256`) so the test you run is the
test that was signed.

## Responsibility

The models are abliterated: no refusal layer sits between you and the model, and no server of ours sees what
you ask. That maximizes both freedom and responsibility — the answers are the model's, unreviewed, and can be
wrong or harmful; what you do with a tool that runs entirely on your own device is on you, as with any tool.

## License

Code: MIT (see `LICENSE`). Model weights: [Qwen3](https://huggingface.co/Qwen) abliterated variants by mlabonne, Apache-2.0 — not included in this repo; fetched as signed releases.
