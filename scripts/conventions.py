"""Front-end conventions that every view has to keep, checked mechanically.

The rules in `ledger/web/README.md` were being applied from memory, and a new
page shipped without one of them — a window control that forgot its choice
the moment you left the page, when the Sports pages had remembered theirs for
months. A rule that lives only in prose gets skipped. These are the ones that
can be checked by reading the source:

  1. A view with a window or range control (`segmented(` + `setQuery(`)
     remembers the choice across visits: it must use `rememberedChoice(` /
     `rememberChoice(` from ui.js, or the Sports pair `sportsRange(` /
     `rememberSportsRange(`.
  2. Every module under ledger/web is listed in `sw.js` SHELL, so it is
     cached for offline use.
  3. Every view registered in `app.js` VIEWS has a route in `scripts/qa.py`
     ROUTES, so the rendering audit covers it.
  4. Every view that renders a panel with a title is indexed in
     docs/DATA-MAP.md — delegated to `scripts/inventory.py --check`.

    .venv/Scripts/python.exe scripts/conventions.py          # report
    .venv/Scripts/python.exe scripts/conventions.py --check  # exit = violations

Add a rule here the day a convention is missed for the second time.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "ledger" / "web"

#: Views whose only `setQuery` is a position in time, not a window the reader
#: picks: the week on screen, the day on screen. Nothing to remember there.
REMEMBER_EXEMPT: set[str] = set()


def rule_remembered_controls() -> list[str]:
    out = []
    for path in sorted(WEB.glob("view-*.js")):
        if path.name in REMEMBER_EXEMPT:
            continue
        src = path.read_text(encoding="utf-8")
        if "segmented(" not in src or "setQuery(" not in src:
            continue
        remembers = any(k in src for k in (
            "rememberedChoice(", "rememberChoice(", "sportsRange(", "rememberSportsRange(",
        ))
        if not remembers:
            out.append(f"{path.name}: has a segmented control that writes the URL but "
                       "does not remember the choice (use ui.js rememberedChoice/rememberChoice)")
    return out


def rule_shell_lists_every_module() -> list[str]:
    sw = (WEB / "sw.js").read_text(encoding="utf-8")
    listed = set(re.findall(r"'/([\w-]+\.js)'", sw))
    out = []
    for path in sorted(WEB.glob("*.js")):
        if path.name == "sw.js":
            continue
        if path.name not in listed:
            out.append(f"sw.js SHELL is missing /{path.name}")
    return out


def rule_qa_covers_every_view() -> list[str]:
    app = (WEB / "app.js").read_text(encoding="utf-8")
    views_block = app[app.index("const VIEWS = {"): app.index("};", app.index("const VIEWS = {"))]
    names = set(re.findall(r"^\s*(\w+):\s*\{\s*module:", views_block, flags=re.M))
    qa = (ROOT / "scripts" / "qa.py").read_text(encoding="utf-8")
    routes_src = qa[qa.index("ROUTES = ["): qa.index("]", qa.index("ROUTES = ["))]
    routes = set(re.findall(r'"([\w-]+)"', routes_src))
    skip = {"edit"}  # needs an id; `add` stands for the entry view
    return [f"scripts/qa.py ROUTES is missing \"{n}\"" for n in sorted(names - routes - skip)]


def rule_inventory() -> list[str]:
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "inventory.py"), "--check"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode == 0:
        return []
    tail = [ln for ln in (r.stdout + r.stderr).splitlines() if ln.strip()][-3:]
    return [f"inventory --check failed ({r.returncode}): " + " / ".join(tail)]


RULES = [
    ("remembered controls", rule_remembered_controls),
    ("service worker shell", rule_shell_lists_every_module),
    ("qa routes", rule_qa_covers_every_view),
    ("data map", rule_inventory),
]


def main(argv: list[str]) -> int:
    check = "--check" in argv
    total = 0
    for name, rule in RULES:
        findings = rule()
        total += len(findings)
        mark = "ok" if not findings else f"{len(findings)} finding{'s' if len(findings) != 1 else ''}"
        print(f"{name:<22} {mark}")
        for f in findings:
            print(f"   - {f}")
    if total == 0:
        print("Every convention holds.")
    return total if check else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
