#!/usr/bin/env python3
"""Design-system guardrail checker for TuneBridge modals.

Current strict scope: sync-modal (migrated family).
This intentionally supports phased rollout.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "static" / "index.html"
STYLE_CSS = ROOT / "static" / "style.css"

STRICT_MODAL_IDS = ["sync-modal"]
ALLOWED_INLINE_STYLE_PATTERNS = [
    re.compile(r"^display\s*:\s*none\s*;?$", re.IGNORECASE),
]
DISALLOWED_INLINE_STYLE_KEYS = (
    "background",
    "color",
    "border",
    "radius",
    "shadow",
    "font",
    "padding",
    "filter",
)


def _extract_modal_block(html: str, modal_id: str) -> str:
    marker = f'<div id="{modal_id}"'
    start = html.find(marker)
    if start < 0:
        return ""
    depth = 0
    i = start
    while i < len(html):
        if html.startswith("<div", i):
            depth += 1
        elif html.startswith("</div>", i):
            depth -= 1
            if depth == 0:
                return html[start : i + len("</div>")]
        i += 1
    return html[start:]


def _is_allowed_inline_style(value: str) -> bool:
    v = " ".join(value.strip().split())
    if any(p.match(v) for p in ALLOWED_INLINE_STYLE_PATTERNS):
        return True
    parts = [part.strip().lower() for part in v.split(";") if part.strip()]
    if parts and all(
        part.startswith(("--scan-pct", "display", "margin-top", "margin-bottom"))
        for part in parts
    ):
        return True
    if any(k in v.lower() for k in DISALLOWED_INLINE_STYLE_KEYS):
        return False
    return True


def check_inline_styles(index_html: Path) -> list[str]:
    html = index_html.read_text(encoding="utf-8")
    violations: list[str] = []
    for modal_id in STRICT_MODAL_IDS:
        block = _extract_modal_block(html, modal_id)
        if not block:
            violations.append(f"{modal_id}: modal block not found")
            continue
        for m in re.finditer(r"style\s*=\s*\"([^\"]+)\"", block, flags=re.IGNORECASE):
            style_value = m.group(1)
            if not _is_allowed_inline_style(style_value):
                excerpt = style_value[:120]
                violations.append(
                    f"{modal_id}: disallowed inline style '{excerpt}'"
                )
    return violations


def check_sync_modal_token_usage(style_css: Path) -> list[str]:
    css = style_css.read_text(encoding="utf-8")
    violations: list[str] = []
    sync_start = css.find("/* ── Sync modal")
    if sync_start < 0:
        return ["sync-modal css block not found"]

    required_tokenized_selectors = [
        "#sync-modal .sync-modal-shell",
        ".sync-modal-icon",
    ]
    for selector in required_tokenized_selectors:
        idx = css.find(selector, sync_start)
        if idx < 0:
            violations.append(f"sync-modal css selector missing: {selector}")
            continue
        end = css.find("}", idx)
        block = css[idx:end] if end > idx else ""
        if "var(--tb-" not in block:
            violations.append(f"sync-modal selector not tokenized: {selector}")
    return violations


def main() -> int:
    if not INDEX_HTML.exists() or not STYLE_CSS.exists():
        print("[modal-guard] required files missing")
        return 2

    violations: list[str] = []
    violations.extend(check_inline_styles(INDEX_HTML))
    violations.extend(check_sync_modal_token_usage(STYLE_CSS))

    if violations:
        print("[modal-guard] FAILED")
        for v in violations:
            print(f"- {v}")
        return 1

    print("[modal-guard] OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
