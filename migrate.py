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

    # Always run schema bootstrap to ensure newly added tables/indexes
    # are created even when schema_version has not changed.
    target_version = max(current_version, db.SCHEMA_VERSION)
    print(f"[migrate] Ensuring schema objects (version {current_version}, target {target_version})")

    try:
        db.create_schema()
        if current_version < db.SCHEMA_VERSION:
            db.set_schema_version(db.SCHEMA_VERSION, 'SQLite schema bootstrap')
        print("[migrate] Schema ready.")
        return True
    except Exception as e:
        print(f"[migrate] ERROR during schema bootstrap: {e}")
        import traceback
        traceback.print_exc()
        return False
