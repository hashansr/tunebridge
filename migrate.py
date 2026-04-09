"""
TuneBridge SQLite schema bootstrap.

This module now manages SQLite schema readiness only.
Legacy JSON migration paths have been removed.
"""

from pathlib import Path

import db


def ensure_db(data_dir: Path) -> bool:
    """
    Ensure the SQLite database exists and schema version is current.

    Returns True when ready, False on failure.
    """
    db.init_db(data_dir)

    try:
        current_version = db.get_schema_version()
    except Exception:
        current_version = 0

    if current_version >= db.SCHEMA_VERSION:
        return True

    print(f"[migrate] Database schema version {current_version} -> {db.SCHEMA_VERSION}")

    try:
        db.create_schema()
        db.set_schema_version(db.SCHEMA_VERSION, 'SQLite schema bootstrap')
        print("[migrate] Schema ready.")
        return True
    except Exception as e:
        print(f"[migrate] ERROR during schema bootstrap: {e}")
        import traceback
        traceback.print_exc()
        return False
