"""
Splits Freehand's training runs into windows that fit a 4 GB card.

A long run (system prompt, request, then many tool calls and results) becomes several rows. Each
row keeps the system prompt and the request; later rows start with the note Freehand itself puts
in when it drops old steps to fit the model's memory, so the windows look like what the model
sees in real use. Every assistant turn lands in exactly one row, so each is trained once.
Tool schemas are left out: with them a single run reaches 14k tokens.

  python -I training/window.py training/freehand.jsonl training/freehand-windows.jsonl 5000
"""
import json
import sys

from transformers import AutoTokenizer

SRC, OUT, LIMIT = sys.argv[1], sys.argv[2], int(sys.argv[3])
tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-4B-Instruct-2507")


def length(msgs):
    fixed = []
    for m in msgs:
        m = dict(m)
        m["tool_calls"] = [
            {**c, "function": {**c["function"], "arguments": json.loads(c["function"]["arguments"]) if isinstance(c["function"]["arguments"], str) else c["function"]["arguments"]}}
            for c in (m.get("tool_calls") or [])
        ] or None
        fixed.append({k: v for k, v in m.items() if v is not None})
    ids = tok.apply_chat_template(fixed, tokenize=True)
    return len(ids["input_ids"] if hasattr(ids, "keys") else ids)


def note(dropped):
    return {"role": "user", "content": f"[{dropped} earlier steps were dropped to fit the model's memory. Check the workspace files for what was done.]"}


rows, too_big = [], 0
for line in open(SRC):
    msgs = json.loads(line)["messages"]
    if length(msgs) <= LIMIT:
        rows.append(msgs)
        continue
    head = msgs[:2]  # system prompt and the request
    units, cur = [], []  # an assistant turn plus the tool results that answer it
    for m in msgs[2:]:
        if m["role"] == "assistant" and cur:
            units.append(cur)
            cur = []
        cur.append(m)
    units.append(cur)
    i = 0
    while i < len(units):
        window = head + ([note(i)] if i else [])
        j = i
        while j < len(units) and length(window + [m for u in units[i:j + 1] for m in u]) <= LIMIT:
            j += 1
        if j == i:  # one step alone is too long: keep it, max_length cuts its end
            too_big += 1
            j = i + 1
        rows.append(window + [m for u in units[i:j] for m in u])
        i = j

with open(OUT, "w") as f:
    for r in rows:
        f.write(json.dumps({"messages": r}) + "\n")
lens = sorted(length(r) for r in rows)
print(f"{len(rows)} rows, median {lens[len(lens) // 2]}, max {lens[-1]}, total {sum(lens)} tokens, {too_big} single steps over {LIMIT}")
