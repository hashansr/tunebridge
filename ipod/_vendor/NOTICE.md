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

To refresh from upstream: re-clone iOpenPod, diff its
`src/iopenpod/{itunesdb_parser,itunesdb_shared}/` and
`src/iopenpod/itunesdb_writer/hash58.py` against this directory, and
re-run the Phase 0 parse-a-real-device smoke test before trusting a
newer version.
