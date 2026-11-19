"""Create the task 2.5 failure cases from the node-postgres template.

Usage: python3 -I scripts/failure-cases/make_cases.py packages/templates/node-postgres <out_dir>
Each case is <out_dir>/<id>/app (c11 also has app-v2: publish app first, then app-v2 as an update).
"""
import json, shutil, sys
from pathlib import Path
T, OUT = Path(sys.argv[1]), Path(sys.argv[2])
FILES = ["app.yaml", "Dockerfile", "package.json", "tsconfig.json", "src", "migrations", "README.md"]

def case(cid, desc, mutate):
    d = OUT / cid / "app"
    if d.exists(): shutil.rmtree(d)
    d.mkdir(parents=True)
    for f in FILES:
        (shutil.copytree if (T / f).is_dir() else shutil.copy)(T / f, d / f)
    mutate(d)
    (OUT / cid / "CASE.txt").write_text(desc + "\n")

def sub(path, old, new):
    s = path.read_text(); assert old in s, (path, old); path.write_text(s.replace(old, new, 1))

def dep(d):
    p = d / "package.json"; j = json.loads(p.read_text()); j["dependencies"]["pg"] = "^8.99.0"; p.write_text(json.dumps(j, indent=2) + "\n")

case("c01", "build: dependency version does not exist", dep)
case("c02", "start: Dockerfile CMD points to a missing file", lambda d: sub(d / "Dockerfile", 'CMD ["node", "dist/server.js"]', 'CMD ["node", "dist/index.js"]'))
case("c03", "start: startup query against a table that does not exist", lambda d: sub(d / "src" / "server.ts",
    "server.listen(port,", 'const { rows: settings } = await pool.query("select title from app_settings limit 1");\nconsole.log("title", settings[0]?.title);\n\nserver.listen(port,'))
case("c04", "migrate: SQL syntax error", lambda d: (d / "migrations" / "002_add_amount.sql").write_text("alter tabel items add column amount numeric(12,2);\n"))
case("c05", "migrate: index on a column that does not exist", lambda d: (d / "migrations" / "002_index.sql").write_text("create index items_amount_idx on items (amount);\n"))
case("c06", "migrate: migrate command refers to a missing npm script", lambda d: sub(d / "app.yaml", "migrate: node dist/migrate.js", "migrate: npm run db:migrate"))
case("c07", "health: port hard-coded to 8080", lambda d: sub(d / "src" / "server.ts", "const port = Number(process.env.PORT ?? 3000);", "const port = 8080;"))
case("c08", "health: listens on 127.0.0.1 only", lambda d: sub(d / "src" / "server.ts", "server.listen(port, ()", 'server.listen(port, "127.0.0.1", ()'))
case("c09", "health: app.yaml healthcheck path does not exist (404)", lambda d: sub(d / "app.yaml", "healthcheck: /healthz", "healthcheck: /health"))
case("c10", "health: healthz queries a missing table (500)", lambda d: sub(d / "src" / "server.ts", 'await pool.query("select 1");', 'await pool.query("select 1 from app_settings");'))
case("c12", "build: TypeScript type error (misspelt property)", lambda d: sub(d / "src" / "server.ts", "escapeHtml(who.name)", "escapeHtml(who.nmae)"))
# c11: update crash. v1 = template as-is, v2 = c03-style crash
case("c11", "update: v1 good; v2 crashes on start (startup query on missing table)", lambda d: None)
shutil.copytree(OUT / "c03" / "app", OUT / "c11" / "app-v2")
print("\n".join(sorted(p.name for p in OUT.iterdir() if p.is_dir())))
