"""Act as the agent: publish the node-postgres template through Ferry's MCP endpoint (task 1.10).

Usage: python3 -I scripts/mcp-publish.py <ferry_url> <template_dir> <app_name> <work_dir>
Example: python3 -I scripts/mcp-publish.py http://127.0.0.1:28080 packages/templates/node-postgres ledger-demo /tmp
Prints each tool result. Exits non-zero if the release does not reach LIVE.
"""
import io
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

FERRY, TEMPLATE, NAME, WORK = sys.argv[1], Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4])
HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "x-ferry-user": "dingtalk:alice",
    "x-ferry-department": "dingtalk:finance",
}
_id = 0


def rpc(method, params):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method, "params": params}).encode()
    req = urllib.request.Request(f"{FERRY}/mcp", data=body, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
    # 响应可能是 SSE:取 data: 行
    payload = next((line[5:].strip() for line in raw.splitlines() if line.startswith("data:")), raw)
    msg = json.loads(payload)
    if "error" in msg:
        raise SystemExit(f"{method} error: {msg['error']}")
    return msg["result"]


def tool(name, args):
    result = rpc("tools/call", {"name": name, "arguments": args})
    text = result["content"][0]["text"]
    if result.get("isError"):
        raise SystemExit(f"{name} failed: {text}")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def zip_template(app_yaml):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(TEMPLATE.rglob("*")):
            if f.is_file() and "node_modules" not in f.parts:
                rel = f.relative_to(TEMPLATE).as_posix()
                z.writestr(rel, app_yaml if rel == "app.yaml" else f.read_bytes())
    return buf.getvalue()


def publish(label):
    print(f"\n===== {label}")
    prepared = tool("prepare_app", {"name": NAME})
    print("prepare_app ->", {k: prepared[k] for k in ("name", "url", "version")})
    app_yaml = (TEMPLATE / "app.yaml").read_text().replace("name: my-app", f"name: {NAME}").replace(
        "visibility: self", "visibility: department"
    )
    data = zip_template(app_yaml)
    up = urllib.request.Request(prepared["uploadUrl"], data=data, method="PUT")
    with urllib.request.urlopen(up, timeout=60) as r:
        print("upload ->", json.loads(r.read()))
    view = tool("publish_app", {"manifestYaml": app_yaml, "version": prepared["version"]})
    print("publish_app ->", view["state"], view["releaseId"])
    started = time.time()
    last = None
    while True:
        view = tool("get_publish_status", {"releaseId": view["releaseId"]})
        if view["state"] != last:
            print(f"  {time.time() - started:5.1f}s {view['state']}")
            last = view["state"]
        if view["done"]:
            break
        time.sleep(3)
    print("result ->", json.dumps({k: view.get(k) for k in ("state", "url", "error", "nextAction")}, ensure_ascii=False)[:800])
    return view


tools = rpc("tools/list", {})
print("tools:", [t["name"] for t in tools["tools"]])
first = publish("发布")
if first["state"] != "LIVE":
    sys.exit(1)
(WORK / "url").write_text(first["url"])
