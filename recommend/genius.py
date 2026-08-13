"""
Genius Playlist generation engine
(PRD "Genius & Continuous Discovery" sections 12-21).

A controlled graph walk around a seed track, not a naive "25 nearest
neighbours" list -- the PRD explicitly warns against that (section 13): it
produces excessive artist/album repetition, a narrow sound, predictable
Refresh behaviour, and no discovery journey.

Builds a playlist one track at a time, walking through four loose arc
phases -- Establish / Expand / Discover / Re-anchor (section 14) -- scoring
candidates on Theme Fit, current-track similarity, session fit, transition
quality, personal affinity, discovery value, and freshness (section 17),
then sampling from the top-scoring band via weighted random choice
(Controlled Randomness, section 20) rather than always taking the single
highest score.

Discovery Value uses the full relevance-gated model from
recommend/discovery.py (section 10: a candidate must clear a relevance
floor -- higher for unheard tracks, section 42 -- before Discovery Value is
even computed for it) and nudges candidate selection toward the requested
Discovery mode's Familiar/Rediscovery/Stretch budget (section 15/52).
personal_affinity/freshness remain simple completion/skip/recency signals.
"""

import random
import time

from recommend.candidates import build_candidate_pool
from recommend.repetition import RepetitionState
from recommend import discovery
from recommend.scoring_utils import norm_key, genre_continuity, weighted_sample, clamp

# Soft phase boundaries as fractions of total playlist length, generalized
# from the PRD's illustrative 25-track example (tracks 1-5/6-12/13-20/21-25)
# to any requested length.
_PHASE_BOUNDS = [
    ('establish', 0.00, 0.20),
    ('expand',    0.20, 0.48),
    ('discover',  0.48, 0.80),
    ('reanchor',  0.80, 1.01),  # slightly over 1.0 so the last index is inclusive
]

# How much weight seed-similarity carries vs. session-similarity, per phase.
# Establish stays close to the seed; Discover is allowed to roam furthest;
# Re-anchor pulls back in (PRD section 14).
_PHASE_SEED_WEIGHT = {
    'establish': 0.85,
    'expand':    0.55,
    'discover':  0.30,
    'reanchor':  0.70,
}

_REFRESH_MAX_OVERLAP = 0.70    # PRD section 21: refreshed playlist should generally not exceed ~60-70% overlap
_REFRESH_MAX_ATTEMPTS = 4


def _phase_for(idx, total):
    t = idx / max(1, total - 1) if total > 1 else 0.0
    for name, lo, hi in _PHASE_BOUNDS:
        if lo <= t < hi:
            return name
    return 'reanchor'


def _apply_filters(candidate_ids, library_by_id, filters):
    if not filters:
        return candidate_ids
    genre = filters.get('genre')
    year_min = filters.get('year_min')
    year_max = filters.get('year_max')
    fmt = filters.get('format')
    out = set()
    for tid in candidate_ids:
        t = library_by_id.get(tid)
        if not t:
            continue
        if genre and genre.lower() not in (t.get('genre') or '').lower():
            continue
        year = t.get('year')
        try:
            year = int(year) if year else None
        except (TypeError, ValueError):
            year = None
        if year_min and (year is None or year < year_min):
            continue
        if year_max and (year is None or year > year_max):
            continue
        if fmt and (t.get('format') or '').lower() != fmt.lower():
            continue
        out.add(tid)
    return out


def _score_candidates(candidate_ids, phase, similarity_index, primary_seed, current_id,
                       session_vec, session_space, library_by_id, play_stats_by_id,
                       favourite_ids, repetition, discovery_mode, category_counts, total_placed,
                       thresholds):
    seed_weight = _PHASE_SEED_WEIGHT[phase]
    scored = []
    for tid in candidate_ids:
        if repetition.is_hard_excluded(tid):
            continue
        track = library_by_id[tid]

        seed_sim = similarity_index.similarity(primary_seed, tid) or 0.0
        current_sim = similarity_index.similarity(current_id, tid) or 0.0
        session_sim = current_sim
        if session_vec is not None:
            s = similarity_index.similarity_to_vector(session_vec, session_space, tid)
            if s is not None:
                session_sim = s

        theme_fit = seed_weight * seed_sim + (1 - seed_weight) * session_sim

        stats = play_stats_by_id.get(tid, {})
        # PRD section 10 + 42: relevance must clear a bar (higher for
        # unheard tracks) before Discovery Value gets to influence ranking
        # at all -- reject here rather than let a novelty bonus rescue an
        # irrelevant candidate.
        if not discovery.passes_relevance_gate(theme_fit, stats):
            continue

        transition = 0.7 * current_sim + 0.3 * genre_continuity(library_by_id.get(current_id), track)

        plays = int(stats.get('plays') or 0)
        valid_plays = int(stats.get('valid_plays') or 0)
        skips = int(stats.get('skips') or 0)
        completions = int(stats.get('completions') or 0)
        last_played = stats.get('last_played')
        is_favourite = tid in favourite_ids

        skip_rate = skips / plays if plays else 0.0
        completion_rate = completions / plays if plays else 0.5
        personal_affinity = clamp(0.5 + 0.35 * completion_rate - 0.3 * skip_rate, 0.0, 1.0)
        if is_favourite:
            personal_affinity = clamp(personal_affinity + 0.15, 0.0, 1.0)
        freshness = 1.0 if not last_played else clamp((time.time() - last_played) / (365 * 86400.0), 0.0, 1.0)

        dv = discovery.discovery_value(stats, is_favourite, thresholds=thresholds)
        category = discovery.discovery_category(stats, is_favourite, thresholds=thresholds)
        budget = discovery.budget_bonus(category, discovery_mode, category_counts, total_placed)

        artist_key = norm_key(track.get('artist'))
        album_key = norm_key(track.get('album'))
        penalty = repetition.penalty_for(tid, artist_key, album_key, last_played)

        score = (
            0.30 * theme_fit
            + 0.20 * current_sim
            + 0.15 * session_sim
            + 0.10 * transition
            + 0.10 * personal_affinity
            + 0.10 * min(dv, 1.0)
            + 0.05 * freshness
            + budget
            - penalty
        )

        scored.append({
            'track_id': tid,
            'score': score,
            'category': category,
            'explanation': {
                'seed_similarity': round(seed_sim, 4),
                'theme_fit': round(theme_fit, 4),
                'transition': round(transition, 4),
                'discovery_value': round(dv, 4),
                'discovery_category': category,
                'repetition_penalty': round(penalty, 4),
                'never_played': valid_plays == 0,
            },
        })
    return scored


def generate_genius_playlist(
    similarity_index,
    seed_ids,
    length,
    library_by_id,
    play_stats_by_id,        # {track_id: {plays, valid_plays, skips, completions, last_played}}
    favourite_ids,           # set of favourited track ids
    filters=None,             # optional constraint dict: genre, year_min, year_max, format
    skipped_recently_recommended_ids=None,
    rng_seed=None,             # omit for a fresh draw; Refresh passes a new seed each call
    discovery_mode='balanced', # 'familiar' | 'balanced' | 'explore' (PRD section 52)
):
    """Generate a Genius Playlist: the seed first (PRD G-02), then a
    controlled graph walk through Establish -> Expand -> Discover ->
    Re-anchor. Returns a list of dicts: {track_id, phase, score, explanation}.
    May return fewer than `length` tracks if the candidate pool runs out
    (small/niche libraries) -- a shorter playlist beats forcing in a bad
    track just to hit a count."""
    rng = random.Random(rng_seed if rng_seed is not None else time.time_ns())
    filters = filters or {}
    if discovery_mode not in discovery.DISCOVERY_MODE_BUDGETS:
        discovery_mode = 'balanced'

    seed_ids = [sid for sid in seed_ids if sid in library_by_id]
    if not seed_ids:
        return []

    result = []
    repetition = RepetitionState(skipped_recently_recommended_ids)
    placed_ids = set()
    category_counts = {'familiar': 0, 'rediscovery': 0, 'stretch': 0}
    thresholds = discovery.compute_library_thresholds(play_stats_by_id)

    def _place(track_id, phase, score, explanation, category='familiar'):
        track = library_by_id[track_id]
        repetition.record(track_id, norm_key(track.get('artist')), norm_key(track.get('album')))
        placed_ids.add(track_id)
        category_counts[category] = category_counts.get(category, 0) + 1
        result.append({'track_id': track_id, 'phase': phase, 'score': round(score, 4), 'explanation': explanation})

    primary_seed = seed_ids[0]
    seed_stats = play_stats_by_id.get(primary_seed, {})
    seed_category = discovery.discovery_category(seed_stats, primary_seed in favourite_ids, thresholds=thresholds)
    _place(primary_seed, 'establish', 1.0, {'reason': 'Seed track'}, seed_category)

    session_space, seed_vec = similarity_index.get_vector(primary_seed)
    session_vec = seed_vec.copy() if seed_vec is not None else None
    current_id = primary_seed

    # Behavioural-neighbour candidate source (PRD section 16's 4th source:
    # "20 behavioural neighbors"). The pure-similarity pool from
    # build_candidate_pool() is drawn from the whole library, so in a
    # library where only a small fraction of tracks have any play history
    # it ends up almost entirely unheard tracks -- the Familiar/Balanced
    # budget below would have nothing real to select even with a strong
    # nudge. Explicitly folding in the user's own played tracks (ranked by
    # seed similarity) gives Familiar/Balanced modes actual candidates.
    played_ids = {tid for tid, s in play_stats_by_id.items() if int(s.get('plays') or 0) > 0}
    _familiar_pool_size = {'familiar': 20, 'balanced': 10, 'explore': 4}

    for i in range(1, length):
        phase = _phase_for(i, length)
        candidate_pool = build_candidate_pool(
            similarity_index, seed_ids, current_id, session_vec, session_space,
            library_by_id, hard_exclude_ids=placed_ids,
        )
        remaining_played = played_ids - placed_ids - candidate_pool
        if remaining_played:
            top_n = _familiar_pool_size.get(discovery_mode, 8)
            ranked = sorted(remaining_played,
                             key=lambda tid: -(similarity_index.similarity(primary_seed, tid) or -1.0))[:top_n]
            candidate_pool = candidate_pool | set(ranked)
        candidate_pool = _apply_filters(candidate_pool, library_by_id, filters)
        if not candidate_pool:
            break

        scored = _score_candidates(
            candidate_pool, phase, similarity_index, primary_seed, current_id,
            session_vec, session_space, library_by_id, play_stats_by_id,
            favourite_ids, repetition, discovery_mode, category_counts, len(result),
            thresholds,
        )
        scored.sort(key=lambda c: c['score'], reverse=True)
        chosen = weighted_sample(scored, rng)
        if chosen is None:
            break

        _place(chosen['track_id'], phase, chosen['score'], chosen['explanation'], chosen['category'])
        current_id = chosen['track_id']

        # Moving session centroid (PRD section 26): recent tracks weighted more.
        if session_vec is not None:
            chosen_space, chosen_vec = similarity_index.get_vector(chosen['track_id'])
            if chosen_space == session_space and chosen_vec is not None:
                session_vec = 0.7 * session_vec + 0.3 * chosen_vec
                norm = float((session_vec ** 2).sum() ** 0.5)
                if norm > 1e-8:
                    session_vec = session_vec / norm

    return result


def refresh_genius_playlist(similarity_index, seed_ids, length, library_by_id, play_stats_by_id,
                             favourite_ids, previous_track_ids, filters=None,
                             skipped_recently_recommended_ids=None, discovery_mode='balanced'):
    """Re-generate around the same seed with a new generation nonce (PRD
    section 21). Retries a few times with fresh randomness if the overlap
    with the previous generation is too high -- overlap is a soft target,
    not a hard requirement, so we accept the last attempt regardless."""
    previous_set = set(previous_track_ids or ())
    best = None
    best_overlap = 1.1
    for _ in range(_REFRESH_MAX_ATTEMPTS):
        generated = generate_genius_playlist(
            similarity_index, seed_ids, length, library_by_id, play_stats_by_id,
            favourite_ids, filters, skipped_recently_recommended_ids, rng_seed=time.time_ns(),
            discovery_mode=discovery_mode,
        )
        ids = {g['track_id'] for g in generated}
        overlap = len(ids & previous_set) / len(ids) if ids else 1.0
        if overlap <= _REFRESH_MAX_OVERLAP:
            return generated
        if overlap < best_overlap:
            best, best_overlap = generated, overlap
    return best or []
