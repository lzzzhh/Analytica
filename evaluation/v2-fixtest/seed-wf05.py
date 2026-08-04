import json, hashlib, pathlib
root = pathlib.Path('/Users/zhanhuilin/Documents/Analytica/evaluation/v2-fixtest/runtime/home/.pi/artifacts/data-analysis')
src = pathlib.Path('/Users/zhanhuilin/Documents/Analytica/evaluation/v2-fixtest/runtime/reviewer-store/artifacts/art_1111222233334444.json')
obj = json.loads(src.read_text())
payload = json.dumps(obj, separators=(",", ":"))
h = hashlib.sha256(payload.encode()).hexdigest()
assert h == "d4930d9546b2ea78b3af18c3e75a5c687f915882b42ba3d42835fa4e97036f68", h
aid = obj["artifactId"]
d = root / "results" / aid
d.mkdir(parents=True, exist_ok=True)
if (d / "COMMITTED").exists():
    print("already seeded"); raise SystemExit
manifest = {"artifactId": aid, "expectedContentHash": h, "schemaVersion": "1.0", "createdAt": "2026-08-03T00:00:00.000Z"}
mstr = json.dumps(manifest, separators=(",", ":"))
mh = hashlib.sha256(mstr.encode()).hexdigest()
(d / "payload.json").write_text(payload)
(d / "manifest.json").write_text(mstr)
(d / "COMMITTED").write_text(mh)
print("seeded", aid, h)
