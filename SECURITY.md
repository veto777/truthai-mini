# Security

## Trust model

Releases are Ed25519-signed. The client hardcodes the release public key (`PINNED_PUBKEY_HEX` in
`app/client.js`, identical to `keys/release_ed25519.pub.hex`) and, before loading anything:
1. refuses a `RELEASE.json` whose key differs from the pin,
2. verifies `MANIFEST.json.ed25519` (raw Ed25519 over the manifest bytes) against the **pinned** key,
3. verifies every shard against the manifest's SHA-256 hashes and writes the verified bytes into the Cache API entries the WebLLM runtime reads from,
4. refuses a `release_sequence` lower than one this device has already verified (anti-rollback).

Scope, stated plainly: the signature covers the release (manifest + shards). `RELEASE.json` itself and the
page/runtime (`app/*`, `vendor/*`) are delivered by the HTTPS origin and are not covered by the release
signature — a compromised origin can serve a different page. The pin protects against tampered *mirrors,
CDNs, IPFS pins and torrents* of the release bytes.

## What is and isn't covered by a hash

Covered and verified before load: the manifest (Ed25519) and every model shard listed in it (SHA-256), including
`mlc-chat-config.json`, written into the browser Cache under the URLs the runtime loads from. Not independently
re-verified after that point: whether the WebLLM build re-reads a given file from that cache versus re-fetching it
from the same origin — the bytes come from the same verified origin either way, but if you require a hard guarantee
that only cache-verified bytes are executed, pin the WebLLM version you audit and serve it yourself. The runtime
itself (`vendor/web-llm.js`, the `.wasm`) is origin-delivered over TLS and outside the release signature.

## Key facts

- Release key fingerprint: `SHA256:lLR0sZXfFRlUHOwmqj65J+iG3JaLMgeeANEhpYLP4RQ` (ed25519)
- The private key lives only on the signing machine (owned hardware, mode 600) with one offline backup on a
  second owned machine. It is never placed on rented or cloud infrastructure.
- **Rotation**: a new key ships as a client update (new `PINNED_PUBKEY_HEX`) together with releases re-signed
  by the new key; the old key's releases stop validating for updated clients.
- **Revocation**: same mechanism — the pin IS the revocation list. If you self-host, you own this decision.

## A note on names

Signatures use the literal namespace `truthcoder-mini` in `ssh-keygen -Y sign -n …`. That string is part of what
was signed for every existing release and is kept stable deliberately — changing it would invalidate the published
verification command. It is an identifier, not a product name; the product is TruthAi Mini.

## Reporting

If you find a way to make the client load unverified bytes, that is the bug we care about most.
Report vulnerabilities via GitHub security advisories on this repository.
