#!/usr/bin/env python3
"""Инструменты режима «Инцидент». Только стандартная библиотека.

  build   --spec SPEC.py --out DIR                  собрать инцидент, самопроверка, печать; выводит commitment
  run     --incident DIR --input FILE [--patch P]   прогнать стенд (python sim.py FILE) на копии, опционально с правкой
  check   --incident DIR --patch P                  применить фикс игрока к копии и прогнать скрытые тесты
  reveal  --incident DIR --commitment HASH          проверить печать и неизменность файлов, показать карту
  journal add|stats [--file CSV]                    журнал прогнозов (по умолчанию ~/.claude/incidents/journal.csv)

Формат спецификации и патча — SKILL.md навыка, пример — assets/incident-spec-example.py.
"""

import argparse
import csv
import datetime
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEAL = HERE / "exam_commit.py"
JOURNAL = Path.home() / ".claude" / "incidents" / "journal.csv"
ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}

SIM = '''\
"""Локальный стенд: прогоняет запросы через обработчик в ОДНОМ процессе, по очереди.
Запросы — файл JSONL, по одному JSON на строку:

    python sim.py requests.jsonl
"""

import json
import sys
import traceback

from {module} import {func} as handle


def main(path):
    with open(path, encoding="utf-8") as f:
        requests = [json.loads(line) for line in f if line.strip()]
    for n, req in enumerate(requests, 1):
        try:
            status, body = handle(req)
        except Exception:
            print(f"#{{n}} 500 Internal Server Error")
            traceback.print_exc(file=sys.stdout)
            continue
        print(f"#{{n}} {{status}} {{json.dumps(body, ensure_ascii=False)}}")


if __name__ == "__main__":
    main(sys.argv[1])
'''

# Одна «жизнь» воркера: все запросы в одном процессе, как в проде.
WORKER = r'''
import importlib, json, sys, traceback
sys.path.insert(0, sys.argv[1])
module, func = sys.argv[2].split(":")
handle = getattr(importlib.import_module(module), func)
out = []
for req in json.loads(sys.stdin.read()):
    try:
        s, b = handle(req)
        out.append([s, b, None])
    except Exception:
        out.append([500, None, traceback.format_exc()])
print(json.dumps(out, ensure_ascii=False))
'''

# Скрытые тесты: каждая t_* получает load(имя_модуля) и выполняется на свежем импорте кода.
RUNNER = r'''
import importlib, importlib.util, os, sys
app, tests_path = os.path.abspath(sys.argv[1]), sys.argv[2]
verbose = "-v" in sys.argv
sys.path.insert(0, app)

def purge():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if f and os.path.abspath(f).startswith(app):
            del sys.modules[name]

spec = importlib.util.spec_from_file_location("hidden_tests", tests_path)
tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tests)
cases = [(k, v) for k, v in vars(tests).items() if k.startswith("t_") and callable(v)]
passed = 0
for name, case in cases:
    purge()
    try:
        case(importlib.import_module)
        passed += 1
        res = "ok"
    except Exception as e:
        res = f"FAIL {type(e).__name__}: {e}"
    if verbose:
        print(f"{name}: {res}")
print(f"{passed}/{len(cases)} passed")
sys.exit(0 if passed == len(cases) else 1)
'''


def die(msg):
    sys.exit(f"ERROR: {msg}")


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def short(s, n=6):
    return hashlib.sha1(s.encode()).hexdigest()[:n]


def load_spec(path):
    spec = importlib.util.spec_from_file_location("incident_spec", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for need in ("FILES", "HIDDEN_TESTS", "REFERENCE_PATCH", "SECRET", "STAND_DIFF"):
        if not hasattr(mod, need):
            die(f"в спецификации нет {need}")
    return mod


def apply_patch(app_dir, patch):
    """patch — список {"file", "old", "new"}; каждый old обязан встречаться ровно один раз."""
    for i, p in enumerate(patch, 1):
        f = Path(app_dir) / p["file"]
        if not f.exists():
            die(f"правка {i}: нет файла {p['file']}")
        text = f.read_text(encoding="utf-8")
        count = text.count(p["old"])
        if count != 1:
            die(f"правка {i}: фрагмент встречается в {p['file']} {count} раз, нужно ровно 1")
        f.write_text(text.replace(p["old"], p["new"]), encoding="utf-8")


def read_patch(path):
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else []


def tests_pass(app_dir, tests_path, verbose=False):
    args = [sys.executable, "-c", RUNNER, str(app_dir), str(tests_path)] + (["-v"] if verbose else [])
    try:
        r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", env=ENV, timeout=120)
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT: тесты не уложились в 120 с (бесконечный цикл?)"
    return r.returncode == 0, (r.stdout + r.stderr).strip()


def patched_copy(incident, patch, tmp):
    dst = Path(tmp) / "app"
    shutil.copytree(Path(incident) / "app", dst)
    apply_patch(dst, patch)
    return dst


def build_log(spec, root, app):
    timeline = getattr(spec, "TIMELINE", None)
    if not timeline:
        return 0
    segments, cur = [], []
    for ev in timeline:
        if ev is None:
            segments.append(cur)
            cur = []
        else:
            cur.append(ev)
    segments.append(cur)

    date, lines, n = getattr(spec, "DATE", "2026-01-01"), [], 0
    for seg in segments:
        reqs = [ev[1] for ev in seg if isinstance(ev[1], dict)]
        r = subprocess.run([sys.executable, "-c", WORKER, str(app), spec.ENTRY], input=json.dumps(reqs),
                           capture_output=True, text=True, encoding="utf-8", env=ENV)
        if r.returncode:
            die("генерация лога упала:\n" + r.stderr)
        results = iter(json.loads(r.stdout))
        for t, ev in seg:
            ts = f"{date} {t}"
            if isinstance(ev, str):
                lines.append(f"{ts} {ev}")
                continue
            n += 1
            rid = short(f"req{n}", 4)
            status, body, tb = next(results)
            head = spec.request_head(rid, ev)
            if status >= 500:
                evt = "evt-" + short(rid)
                tb = (tb or "").replace(str(app), "/srv/app").replace("\\", "/")
                (root / "sentry" / f"{evt}.txt").write_text(f"{evt}  {ts}  req={rid}\n\n{tb}", encoding="utf-8")
                lines.append(f"{ts} ERROR {head} -> {status} Internal Server Error sentry={evt}")
            else:
                lines.append(f"{ts} INFO  {head} -> {spec.ok_tail(status, body)}")
    (root / "app.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def cmd_build(a):
    spec = load_spec(a.spec)
    root = Path(a.out).expanduser()
    if root.exists():
        die(f"{root} уже существует — не перезаписываю")
    app, sealed = root / "app", root / ".sealed"
    for rel, text in spec.FILES.items():
        (app / rel).parent.mkdir(parents=True, exist_ok=True)
        (app / rel).write_text(text, encoding="utf-8")
    entry = getattr(spec, "ENTRY", None)
    if entry and "sim.py" not in spec.FILES:
        module, func = entry.split(":")
        (app / "sim.py").write_text(SIM.format(module=module, func=func), encoding="utf-8")
    for rel, text in getattr(spec, "ROOT_FILES", {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    (root / "sentry").mkdir(parents=True, exist_ok=True)
    sealed.mkdir(parents=True)
    tests = sealed / "hidden_tests.py"
    tests.write_text(spec.HIDDEN_TESTS, encoding="utf-8")
    log_lines = build_log(spec, root, app)

    ok_bug, out_bug = tests_pass(app, tests)
    with tempfile.TemporaryDirectory() as tmp:
        ok_ref, out_ref = tests_pass(patched_copy(root, spec.REFERENCE_PATCH, tmp), tests)
    if ok_bug or not ok_ref:
        shutil.rmtree(root)
        die("самопроверка не прошла: баг должен валить тесты, эталонный фикс — проходить.\n"
            f"с багом: {out_bug.splitlines()[-1] if out_bug else '?'}; эталон: {out_ref}")

    public = [p for p in root.rglob("*") if p.is_file() and sealed not in p.parents]
    state = dict(spec.SECRET)
    state.update({
        "stand_diff": spec.STAND_DIFF,
        "reference_patch": spec.REFERENCE_PATCH,
        "files_sha256": {p.relative_to(root).as_posix(): sha(p) for p in public},
        "hidden_tests_sha256": sha(tests),
    })
    tmp_state = sealed / "state.json"
    tmp_state.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    r = subprocess.run([sys.executable, str(SEAL), "seal", "--state", str(tmp_state),
                        "--sealed", str(sealed / "sealed.json")], capture_output=True, text=True, env=ENV)
    tmp_state.unlink()
    if r.returncode:
        die("печать не создана:\n" + r.stderr)
    shutil.copy(a.spec, sealed / "spec.py")
    for p in app.rglob("__pycache__"):
        shutil.rmtree(p, ignore_errors=True)
    print("self-check: ok")
    print(r.stdout.splitlines()[0])
    print(f"public files: {len(public)} | log lines: {log_lines} | sentry events: "
          f"{len(list((root / 'sentry').iterdir()))}")


def cmd_run(a):
    with tempfile.TemporaryDirectory() as tmp:
        app = patched_copy(a.incident, read_patch(a.patch), tmp)
        r = subprocess.run([sys.executable, "sim.py", str(Path(a.input).resolve())], cwd=app,
                           capture_output=True, text=True, encoding="utf-8", env=ENV, timeout=60)
        out = (r.stdout + r.stderr).replace(str(app), "...").replace("\\", "/")
    print(out.rstrip())


def cmd_check(a):
    tests = Path(a.incident) / ".sealed" / "hidden_tests.py"
    with tempfile.TemporaryDirectory() as tmp:
        ok, out = tests_pass(patched_copy(a.incident, read_patch(a.patch), tmp), tests, verbose=True)
    print(out)
    sys.exit(0 if ok else 1)


def cmd_reveal(a):
    root = Path(a.incident)
    sealed = root / ".sealed" / "sealed.json"
    r = subprocess.run([sys.executable, str(SEAL), "verify", "--sealed", str(sealed), "--commitment", a.commitment],
                       capture_output=True, text=True, env=ENV)
    print((r.stdout + r.stderr).strip())
    state = json.loads(sealed.read_text(encoding="utf-8"))["state"]
    # ранние сборки хранили пути относительно app/, а не корня инцидента
    paths = {f: root / f if (root / f).exists() else root / "app" / f for f in state["files_sha256"]}
    changed = [f for f, h in state["files_sha256"].items() if not paths[f].exists() or sha(paths[f]) != h]
    if sha(root / ".sealed" / "hidden_tests.py") != state["hidden_tests_sha256"]:
        changed.append(".sealed/hidden_tests.py")
    print("files unchanged since seal" if not changed else f"CHANGED SINCE SEAL: {changed}")
    for k, v in state.items():
        if k not in ("files_sha256", "hidden_tests_sha256"):
            print(f"{k}: {json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v}")


FIELDS = ["date", "mode", "id", "level", "forecast", "outcome", "brier", "checks", "hints", "note"]


def cmd_journal(a):
    path = Path(a.file).expanduser()
    if a.action == "add":
        if not 0 <= a.forecast <= 1 or a.outcome not in (0, 1):
            die("forecast — число 0..1, outcome — 0 или 1")
        path.parent.mkdir(parents=True, exist_ok=True)
        new = not path.exists()
        row = {"date": a.date or datetime.date.today().isoformat(), "mode": a.mode, "id": a.id,
               "level": a.level, "forecast": a.forecast, "outcome": a.outcome,
               "brier": round((a.forecast - a.outcome) ** 2, 4), "checks": a.checks, "hints": a.hints,
               "note": a.note}
        with path.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            if new:
                w.writeheader()
            w.writerow(row)
        print(f"added: {row}")
        return
    if not path.exists():
        print("журнал пуст")
        return
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    briers = [float(r["brier"]) for r in rows]
    print(f"игр: {len(rows)} | средняя ошибка прогноза (Brier): {sum(briers) / len(briers):.3f} "
          f"| решено: {sum(int(r['outcome']) for r in rows)}/{len(rows)}")
    if len(briers) >= 6:
        half = len(briers) // 2
        print(f"первая половина: {sum(briers[:half]) / half:.3f} → вторая: "
              f"{sum(briers[half:]) / (len(briers) - half):.3f}")
    for r in rows[-5:]:
        print(f"  {r['date']} {r['mode']} {r['id']} ур.{r['level']} p={r['forecast']} "
              f"исход={r['outcome']} проверки={r['checks']} подсказки={r['hints']}  {r['note']}")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--spec", required=True)
    b.add_argument("--out", required=True)
    r = sub.add_parser("run")
    r.add_argument("--incident", required=True)
    r.add_argument("--input", required=True)
    r.add_argument("--patch")
    c = sub.add_parser("check")
    c.add_argument("--incident", required=True)
    c.add_argument("--patch", required=True)
    v = sub.add_parser("reveal")
    v.add_argument("--incident", required=True)
    v.add_argument("--commitment", required=True)
    j = sub.add_parser("journal")
    j.add_argument("action", choices=["add", "stats"])
    j.add_argument("--file", default=str(JOURNAL))
    j.add_argument("--date")
    j.add_argument("--mode", default="incident")
    j.add_argument("--id", default="")
    j.add_argument("--level", default="")
    j.add_argument("--forecast", type=float, default=0.5)
    j.add_argument("--outcome", type=int, default=0)
    j.add_argument("--checks", default="")
    j.add_argument("--hints", default="0")
    j.add_argument("--note", default="")
    a = p.parse_args()
    {"build": cmd_build, "run": cmd_run, "check": cmd_check, "reveal": cmd_reveal, "journal": cmd_journal}[a.cmd](a)


if __name__ == "__main__":
    main()
