"""
Merges Soup's LoRA adapter into the base model one tensor at a time, so it fits in a few GB of RAM.
(soup export merges the whole model in memory, which needs about 8 GB.)

  python -I training/merge_lora.py <base model dir> training/output training/merged

The result is a normal safetensors model that `ollama create` can import and quantize.
"""
import json
import os
import shutil
import sys

import torch
from safetensors import safe_open
from safetensors.torch import save_file

BASE, ADAPTER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SHARD_BYTES = 1_000_000_000  # small shards keep the peak low

cfg = json.load(open(os.path.join(ADAPTER, "adapter_config.json")))
assert not cfg.get("use_dora") and not cfg.get("use_rslora"), "only plain LoRA is handled"
scale = cfg["lora_alpha"] / cfg["r"]

lora = {}
with safe_open(os.path.join(ADAPTER, "adapter_model.safetensors"), "pt") as f:
    for k in f.keys():
        # base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight -> model.layers.0.self_attn.q_proj.weight
        name, part = k.replace("base_model.model.", "", 1).rsplit(".lora_", 1)
        lora.setdefault(name + ".weight", {})[part.split(".")[0]] = f.get_tensor(k).float()

os.makedirs(OUT, exist_ok=True)
index = json.load(open(os.path.join(BASE, "model.safetensors.index.json")))
files = sorted(set(index["weight_map"].values()))
weight_map, shard, size, n, merged = {}, {}, 0, 0, 0


def flush():
    global shard, size, n
    if not shard:
        return
    n += 1
    name = f"model-{n:05d}.safetensors"
    save_file(shard, os.path.join(OUT, name), metadata={"format": "pt"})
    for k in shard:
        weight_map[k] = name
    shard, size = {}, 0


for fname in files:
    with safe_open(os.path.join(BASE, fname), "pt") as f:
        for k in f.keys():
            t = f.get_tensor(k)
            if k in lora:
                ab = lora.pop(k)
                t = (t.float() + scale * (ab["B"] @ ab["A"])).to(t.dtype)
                merged += 1
            shard[k] = t.contiguous()
            size += t.numel() * t.element_size()
            if size >= SHARD_BYTES:
                flush()
flush()
assert not lora, f"adapter weights with no base tensor: {list(lora)[:3]}"

json.dump({"metadata": {"total_size": sum(os.path.getsize(os.path.join(OUT, v)) for v in set(weight_map.values()))}, "weight_map": weight_map},
          open(os.path.join(OUT, "model.safetensors.index.json"), "w"), indent=2)
for extra in ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"]:
    if os.path.exists(os.path.join(BASE, extra)):
        shutil.copy(os.path.join(BASE, extra), OUT)
print(f"merged {merged} tensors (scale {scale}) into {n} shards in {OUT}")
