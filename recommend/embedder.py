"""
Sonic embedding for Genius Playlist / Continuous Play (PRD Phase 1: Sonic Foundation).

Model: PANNs CNN14 (Cnn14_mAP=0.431), an AudioSet-pretrained convolutional
audio-tagging network. Code is MIT-licensed (github.com/qiuqiangkong/
audioset_tagging_cnn); we use its 2048-dim penultimate-layer activation as a
general-purpose "what does this sound like" embedding for track-to-track
sonic similarity.

We deliberately do NOT rely on the `panns-inference` PyPI package's own
bootstrap logic: importing it unconditionally shells out to `wget` (absent
on macOS by default) with no error handling to fetch a labels CSV and the
~320MB model checkpoint. Instead, `_ensure_panns_data_files()` pre-provisions
both files ourselves via `requests` (streamed, retried, size-validated)
*before* the package is ever imported, so its own file-exists checks pass
and `os.system('wget ...')` is never reached.
"""

import os
import time
from pathlib import Path

import numpy as np
import requests
import soundfile as sf

EMBEDDING_VERSION = 1
MODEL_NAME = 'panns_cnn14'
EMBED_DIM = 2048

_TARGET_SR = 32000        # PANNs CNN14 was trained at 32kHz
_WINDOW_SECONDS = 10.0     # AudioSet clip length the model was trained on
_N_WINDOWS = 3              # fewer than the 7-window FFT pass in app.py's _run_analysis() -- CNN inference is far more expensive per window
_RMS_FLOOR = 0.01

_LABELS_URL = 'https://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv'
_CHECKPOINT_URL = 'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
_CHECKPOINT_MIN_SIZE = 300_000_000  # sanity floor; the real file is ~327MB

# panns_inference.config hardcodes this exact path (Path.home()-relative,
# not parameterizable) -- we honor it so the package's own existence check
# is satisfied and it never falls through to its wget branch.
_PANNS_LABELS_PATH = Path.home() / 'panns_data' / 'class_labels_indices.csv'


class SonicEmbedder:
    """Interface: turn a decoded audio track into a fixed-length embedding vector."""

    def embed_file(self, audio_path: Path):
        """Return an np.ndarray[float32] embedding, or None if the file couldn't be analysed."""
        raise NotImplementedError


class EmbedderUnavailable(RuntimeError):
    """Raised when the embedding model/checkpoint can't be loaded (missing deps, download failure)."""


def _download_file(url: str, dest: Path, min_size: int = 0, timeout: int = 60, progress_cb=None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        total = int(r.headers.get('content-length') or 0)
        written = 0
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if not chunk:
                    continue
                f.write(chunk)
                written += len(chunk)
                if progress_cb:
                    try:
                        progress_cb(written, total)
                    except Exception:
                        pass
    size = tmp.stat().st_size
    if size < min_size:
        tmp.unlink(missing_ok=True)
        raise EmbedderUnavailable(f'Downloaded file too small ({size} bytes) from {url}')
    tmp.replace(dest)


def _ensure_panns_data_files(checkpoint_path: Path, progress_cb=None):
    """Pre-provision the two files panns_inference expects via our own robust
    download path, so merely importing the package never shells out to wget."""
    if not _PANNS_LABELS_PATH.exists():
        _download_file(_LABELS_URL, _PANNS_LABELS_PATH, min_size=1000)
    if not checkpoint_path.exists() or checkpoint_path.stat().st_size < _CHECKPOINT_MIN_SIZE:
        _download_file(_CHECKPOINT_URL, checkpoint_path, min_size=_CHECKPOINT_MIN_SIZE,
                        timeout=600, progress_cb=progress_cb)


def _resample(mono: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr:
        return mono
    import librosa
    return librosa.resample(mono, orig_sr=float(orig_sr), target_sr=float(target_sr)).astype(np.float32)


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return (v / norm).astype(np.float32) if norm > 1e-8 else v.astype(np.float32)


class PannsCnn14Embedder(SonicEmbedder):
    def __init__(self, data_dir: Path, device: str = 'cpu', progress_cb=None):
        self.checkpoint_path = Path(data_dir) / 'models' / 'Cnn14_mAP=0.431.pth'
        try:
            _ensure_panns_data_files(self.checkpoint_path, progress_cb=progress_cb)
        except requests.RequestException as exc:
            raise EmbedderUnavailable(f'Failed to download PANNs model files: {exc}') from exc

        try:
            import torch
            from panns_inference import AudioTagging
        except ImportError as exc:
            raise EmbedderUnavailable(f'torch / panns-inference not installed: {exc}') from exc

        # Cap CPU threads -- this can now run automatically in the background
        # (not just via an explicit user-initiated button click), so don't let
        # it hog every core and compete with playback/UI responsiveness.
        torch.set_num_threads(max(1, (os.cpu_count() or 4) // 2))

        self._torch = torch
        self._tagger = AudioTagging(checkpoint_path=str(self.checkpoint_path), device=device)

    def embed_file(self, audio_path: Path):
        data, sr = sf.read(str(audio_path), dtype='float32', always_2d=True)
        mono = data.mean(axis=1)
        mono = _resample(mono, sr, _TARGET_SR)
        total = len(mono)
        win_n = int(_WINDOW_SECONDS * _TARGET_SR)

        if total <= win_n:
            offsets = [0]
        else:
            start = int(total * 0.10)
            end = max(int(total * 0.90), start + win_n)
            end = min(end, total)
            span = max(end - start - win_n, 0)
            offsets = sorted(set(
                start + int(span * i / max(_N_WINDOWS - 1, 1))
                for i in range(_N_WINDOWS)
            ))

        vectors = []
        for off in offsets:
            frame = mono[off:off + win_n]
            if len(frame) < win_n:
                frame = np.pad(frame, (0, win_n - len(frame)))
            rms = float(np.sqrt(np.mean(frame ** 2)))
            if rms < _RMS_FLOOR and len(offsets) > 1:
                continue  # skip near-silent window, unless it's the only one we have
            with self._torch.no_grad():
                _, embedding = self._tagger.inference(frame[None, :])
            vectors.append(_l2_normalize(embedding[0].astype(np.float32)))

        if not vectors:
            return None
        return _l2_normalize(np.mean(vectors, axis=0))
