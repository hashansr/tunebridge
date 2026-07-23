-- Full, clean removal of the click-wheel iPod sync feature's schema.
--
-- All five tables are additive-only (plain CREATE TABLE IF NOT EXISTS in db.py,
-- never an ALTER TABLE migration against an existing table), so dropping them
-- here fully reverts the schema with no other cleanup required and no impact
-- on tracks/playlists/daps/sync_manifest or any other existing table.
--
-- Usage: sqlite3 tunebridge.db < ipod/rollback.sql
DROP TABLE IF EXISTS ipod_itunesdb_backups;
DROP TABLE IF EXISTS ipod_sync_manifest;
DROP TABLE IF EXISTS ipod_playlists;
DROP TABLE IF EXISTS ipod_tracks;
DROP TABLE IF EXISTS ipods;
