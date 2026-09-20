#!/usr/bin/env python3
"""Complete the converted model dir: mlc-chat-config.json = the official stock config (same architecture, same wasm), with
context_window_size 4096 and thinking disabled by default; tokenizer files copied from OUR checkpoint (commit-pinned)."""
import json, shutil, sys, os
if len(sys.argv) < 4 or sys.argv[1] in ("-h","--help"):
    sys.exit("usage: assemble_model_dir.py <hf_dir> <stock_mlc_chat_config.json> <out_dir>")

hf, stock_cfg, out = sys.argv[1], sys.argv[2], sys.argv[3]
c = json.load(open(stock_cfg))
c["context_window_size"] = 4096; c["prefill_chunk_size"] = min(c.get("prefill_chunk_size", 2048), 2048)
c["conv_template"]["system_message"] = "You are a helpful assistant."
c["tokenizer_files"] = [f for f in ["tokenizer.json", "vocab.json", "merges.txt", "tokenizer_config.json"] if os.path.exists(os.path.join(hf, f))]
c["model_config"]["context_window_size"] = 4096
json.dump(c, open(os.path.join(out, "mlc-chat-config.json"), "w"), indent=2)
for f in c["tokenizer_files"] + ["added_tokens.json", "special_tokens_map.json", "generation_config.json"]:
    if os.path.exists(os.path.join(hf, f)): shutil.copy(os.path.join(hf, f), os.path.join(out, f))
print("assembled:", sorted(os.listdir(out))[:8], "…", "tokenizer_files", c["tokenizer_files"], "ctx", c["context_window_size"], "chunk", c["prefill_chunk_size"])
