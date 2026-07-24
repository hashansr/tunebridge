# Vendored code

`iopenpod/itunesdb_parser/`, `iopenpod/itunesdb_shared/`, and
`iopenpod/itunesdb_writer/hash58.py` are copied unmodified from
[iOpenPod](https://github.com/TheRealSavi/iOpenPod) by John Gibbons
(MIT License, see `LICENSE` in this directory), commit-pinned to the
state cloned during the Phase 0 research spike (2026-07-24).

Only the GUI-free binary iTunesDB parsing/hashing modules are
vendored — none of iOpenPod's PyQt6 GUI, device-management, sync, or
transcoding code. Verified during Phase 0 to import standalone with
zero PyQt6 dependency and to correctly parse a real, populated
iTunesDB (3,286 tracks) from a physical iPod 5th Gen.

TuneBridge's own `ipod/itunesdb_reader.py` and `ipod/checksum.py`
wrap this vendored code and are what the rest of the app imports —
nothing outside `ipod/_vendor/` should import from `iopenpod.*`
directly, so this directory can be updated or swapped out as a unit.

Phase 2 (2026-07-24) added the rest of `itunesdb_writer/` (the
GUI-free per-chunk writers — mhit, mhyp, mhla, mhli, mhod, mhod52,
mhod_spl, mhsd, mhlt, mhlp, mhip — same clean-import verification as
above). `ipod/itunesdb_writer.py` orchestrates these directly rather
than importing iOpenPod's own `mhbd_writer.py::write_mhbd()`, which
pulls in the whole `iopenpod.device` package.

**Local patch, not present upstream**: `itunesdb_writer/mhit_writer.py`
line ~474, `has_artwork` derivation. Upstream only checks
`artwork_count > 0`; also checks `mhii_link` (artwork_id_ref) — a real
device library had 35/3286 tracks with `has_artwork=1` and a real
ArtworkDB link but `artwork_count=0`, which the upstream logic would
silently flip to "no artwork" on every rewrite. Re-check this against
upstream on any future refresh; it may get fixed there independently.

To refresh from upstream: re-clone iOpenPod, diff its
`src/iopenpod/{itunesdb_parser,itunesdb_shared,itunesdb_writer}/`
(excluding `mhbd_writer.py`, not vendored) against this directory —
reapply the `has_artwork` patch above if it hasn't landed upstream —
and re-run the Phase 0/2 real-device round-trip checks before trusting
a newer version.
