"""Publish an app dir through Ferry's MCP endpoint and save the final release view.
Usage: run_case.py <ferry_url> <token_file> <app_dir> <app_name> <out_json>"""
import io, json, re, sys, time, urllib.request, zipfile
from pathlib import Path
FERRY, TOKEN, APP, NAME, OUT = sys.argv[1], Path(sys.argv[2]).read_text().strip(), Path(sys.argv[3]), sys.argv[4], Path(sys.argv[5])
H = {"content-type": "application/json", "accept": "application/json, text/event-stream", "authorization": f"Bearer {TOKEN}"}
n = 0
def tool(name, args):
    global n; n += 1
    body = json.dumps({"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()
    raw = urllib.request.urlopen(urllib.request.Request(f"{FERRY}/mcp", body, H), timeout=60).read().decode()
    msg = json.loads(next((l[5:] for l in raw.splitlines() if l.startswith("data:")), raw))
    r = msg["result"]; text = r["content"][0]["text"]
    if r.get("isError"): return {"toolError": text}
    return json.loads(text)
manifest = re.sub(r"^name: .*$", f"name: {NAME}", (APP / "app.yaml").read_text(), flags=re.M)
prep = tool("prepare_app", {"name": NAME})
if "toolError" in prep: OUT.write_text(json.dumps(prep, ensure_ascii=False, indent=2)); sys.exit(print(prep))
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    for p in sorted(APP.rglob("*")):
        if p.is_file() and "node_modules" not in p.parts:
            rel = p.relative_to(APP).as_posix()
            z.writestr(rel, manifest if rel == "app.yaml" else p.read_bytes())
req = urllib.request.Request(prep["uploadUrl"], buf.getvalue(), method="PUT")
urllib.request.urlopen(req, timeout=60).read()
view = tool("publish_app", {"name": NAME, "version": prep["version"]})
t0 = time.time()
while "toolError" not in view and not view["done"]:
    time.sleep(3); view = tool("get_publish_status", {"releaseId": view["releaseId"]})
view["_seconds"] = round(time.time() - t0)
OUT.write_text(json.dumps(view, ensure_ascii=False, indent=2))
e = view.get("error") or {}
print(f"{NAME}: {view.get('state')} stage={e.get('stage')} type={e.get('type')} {view['_seconds']}s logs={len(e.get('logs') or '')}ch")
