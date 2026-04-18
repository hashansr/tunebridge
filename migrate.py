"""
TuneBridge SQLite schema bootstrap and migration runner.

On every startup:
  1. create_schema() runs all CREATE TABLE IF NOT EXISTS statements (safe/idempotent,
     handles fresh installs and new tables).
  2. _run_migrations() applies any pending ALTER TABLE entries from db._MIGRATIONS
     that have a version number higher than the currently recorded schema_version.
     The DB is backed up automatically before the first migration in a session.
"""

import shutil
import sqlite3
from pathlib import Path

import db


def ensure_db(data_dir: Path) -> bool:
    """
    Ensure the SQLite database exists and schema is fully up to date.

    Returns True when ready, False on failure.
    """
    db.init_db(data_dir)

    try:
        current_version = db.get_schema_version()
    except Exception:
        current_version = 0

    migration_target = max((m[0] for m in db._MIGRATIONS), default=0)
    target_version = max(db.SCHEMA_VERSION, migration_target)
    print(f"[migrate] schema v{current_version} → v{target_version}")

    try:
        # Always run base schema (creates missing tables, safe to re-run)
        db.create_schema()

        # Apply any pending ALTER TABLE migrations
        pending = [m for m in db._MIGRATIONS if m[0] > current_version]
        if pending:
            _backup_db(data_dir, pending[0][0])
            _run_migrations(pending)
        elif current_version < db.SCHEMA_VERSION:
            db.set_schema_version(db.SCHEMA_VERSION, 'SQLite schema bootstrap')

        print("[migrate] Schema ready.")
        return True
    except Exception as e:
        print(f"[migrate] ERROR during schema bootstrap: {e}")
        import traceback
        traceback.print_exc()
        return False


def _backup_db(data_dir: Path, first_new_version: int) -> None:
    db_path = data_dir / 'tunebridge.db'
    if not db_path.exists():
        return
    backup_path = data_dir / f'tunebridge.db.pre-v{first_new_version}.bak'
    shutil.copy2(db_path, backup_path)
    print(f"[migrate] Backup saved → {backup_path.name}")
    _prune_backups(data_dir, keep=3)


def _prune_backups(data_dir: Path, keep: int = 3) -> None:
    backups = sorted(data_dir.glob('tunebridge.db.pre-v*.bak'))
    for old in backups[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass


def _run_migrations(pending: list) -> None:
    conn = db.get_conn()
    for version, description, sql_list in pending:
        print(f"[migrate] Applying migration v{version}: {description}")
        if sql_list:
            for stmt in sql_list:
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError as e:
                    if 'duplicate column' in str(e).lower():
                        print(f"[migrate]   Skipped (already applied): {e}")
                    else:
                        raise
            conn.commit()
        db.set_schema_version(version, description)
