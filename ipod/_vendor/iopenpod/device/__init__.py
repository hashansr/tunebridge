"""Minimal local stand-in for iopenpod.device.

Upstream's real __init__.py re-exports its entire device package,
including USB backends (vpd_libusb, vpd_usb_control) and a filesystem
scanner (scanner.py) - exactly the GUI/device coupling this project's
vendoring deliberately avoids (see ../../NOTICE.md). This file only
re-exports the names artworkdb_shared/artworkdb_writer actually import
from `iopenpod.device` at module load time, sourced from the clean,
dependency-free submodules that ARE vendored here (artwork_presets,
checksum, models, capabilities, artwork).

`get_current_device_for_path` (real USB device auto-detection) is
intentionally not provided - callers that need it use lazy
`from iopenpod.device import get_current_device_for_path` inside a
function body, which only fails if that specific function is actually
called. TuneBridge never calls it: device model is user-selected
(ipods.device_class), not auto-detected from USB.
"""
from .artwork import (  # noqa: F401
    ITHMB_FORMAT_MAP,
    ITHMB_SIZE_MAP,
    cover_art_format_definitions_for_device,
    ithmb_formats_for_device,
    photo_formats_for_device,
    resolve_cover_art_format_definitions,
    resolve_cover_art_format_definitions_for_device,
)
from .artwork_presets import (  # noqa: F401
    ARTWORK_FORMATS_BY_ID,
    ArtworkFormat,
)
from .capabilities import (  # noqa: F401
    DeviceCapabilities,
    capabilities_for_family_gen,
    checksum_type_for_family_gen,
    cover_art_formats_for_family_gen,
)
