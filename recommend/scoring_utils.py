"""
Small scoring helpers shared between recommend/genius.py and
recommend/continuous.py -- kept here rather than duplicated so the two
features can't drift on basic things like genre-continuity or the
Controlled Randomness sampling method (PRD section 20).
"""

import math
import re


def norm_key(s):
    return (s or '').strip().lower()


_VERSION_TAG_TERMS = (
    r'live(?:\s+(?:in|at)\s+[^()\[\]-]+)?|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster|'
    r'acoustic|unplugged|single\s+version|album\s+version|radio\s+edit|mono|stereo|demo|'
    r'deluxe(?:\s+edition)?|bonus\s+track|explicit|clean|extended(?:\s+version)?|'
    r'instrumental|karaoke(?:\s+version)?|original\s+(?:mix|version|recording)'
)
_PAREN_VERSION_RE = re.compile(
    r'\s*[\(\[][^()\[\]]*\b(?:' + _VERSION_TAG_TERMS + r')\b[^()\[\]]*[\)\]]',
    re.IGNORECASE,
)
_DASH_VERSION_RE = re.compile(
    r'\s+-\s+(?:' + _VERSION_TAG_TERMS + r')\s*$',
    re.IGNORECASE,
)


def strip_version_tags(title):
    """Strip common version/edition qualifiers (Live, Remastered, Acoustic,
    Radio Edit, etc.) so different recordings of the same underlying song
    normalize to the same title. Not exhaustive -- only needs to catch the
    common cases. Mirrors app.py's _EDITION_RE/_strip_edition_tags, kept
    independent here since recommend/ must not import the Flask app."""
    s = title or ''
    s = _PAREN_VERSION_RE.sub('', s)
    s = _DASH_VERSION_RE.sub('', s)
    return s.strip(' -–—').strip()


def norm_song_key(track):
    """Session-wide dedup key for 'same underlying song regardless of
    recording/version': normalized-stripped-title + normalized artist, so
    different songs that happen to share a title across different artists
    aren't merged together."""
    if not track:
        return None
    title_key = norm_key(strip_version_tags(track.get('title')))
    artist_key = norm_key(track.get('artist'))
    if not title_key:
        return None
    return f"{title_key}|{artist_key}"


def split_genres(genre_str):
    if not genre_str:
        return []
    return [g.strip().lower() for g in genre_str.replace(';', ',').split(',') if g.strip()]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def genre_continuity(prev_track, cur_track):
    if not prev_track or not cur_track:
        return 0.5
    prev_genres = set(split_genres(prev_track.get('genre')))
    cur_genres = set(split_genres(cur_track.get('genre')))
    if not prev_genres or not cur_genres:
        return 0.5
    return 1.0 if (prev_genres & cur_genres) else 0.3


def weighted_sample(scored_candidates, rng, band_size=15, temperature=0.12):
    """Controlled randomness (PRD section 20): retain the strongest
    candidate band, convert scores to weighted probabilities, sample from
    that band. Higher-scoring tracks remain more likely; bad candidates
    never enter the lottery because they never make the band."""
    band = scored_candidates[:band_size]
    if not band:
        return None
    scores = [c['score'] for c in band]
    max_score = max(scores)
    weights = [math.exp((s - max_score) / temperature) for s in scores]
    total_w = sum(weights)
    r = rng.uniform(0, total_w)
    upto = 0.0
    for c, w in zip(band, weights):
        upto += w
        if upto >= r:
            return c
    return band[-1]
