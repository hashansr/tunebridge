"""
Small scoring helpers shared between recommend/genius.py and
recommend/continuous.py -- kept here rather than duplicated so the two
features can't drift on basic things like genre-continuity or the
Controlled Randomness sampling method (PRD section 20).
"""

import math


def norm_key(s):
    return (s or '').strip().lower()


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
