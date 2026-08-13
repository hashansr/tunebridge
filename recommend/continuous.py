"""
Continuous Play generation engine
(PRD "Genius & Continuous Discovery" sections 22-33).

Unlike Genius Playlist (a one-shot finite generation), Continuous Play is a
live "local DJ": each call generates a small lookahead (PRD section 55:
roughly 3 tracks) based on the session so far, observes what happens, and
generates again. There is no persisted server-side session object -- each
call rebuilds SessionContext (section 24) fresh from what the client sends
(recent accepted tracks, which of those were manual vs. generated, the
session's original anchor, recent skip events). This mirrors both the
existing (pre-Continuous-Play) autoplay endpoint's stateless design and how
player.js already tracks its own session state client-side.
"""

import random
import time

from recommend.candidates import build_candidate_pool
from recommend.repetition import RepetitionState
from recommend import discovery
from recommend.scoring_utils import norm_key, genre_continuity, weighted_sample, clamp

# PRD section 27: anchor influence starts high and decays as the session
# continues, so a long session doesn't run away into unrelated territory
# just by chaining neighbour-of-neighbour-of-neighbour.
_ANCHOR_INFLUENCE_EARLY = 0.75   # tracks 1-5 of the session
_ANCHOR_INFLUENCE_MID = 0.45      # tracks 6-15
_ANCHOR_INFLUENCE_LATE = 0.25      # tracks 16+
_ANCHOR_WEIGHT_BASE = 0.15          # base scoring weight anchor similarity gets at full (early) influence

# PRD section 30: never stack more than 2 exploration/stretch tracks in a row
# without a strong match or rediscovery to give the listener reassurance.
_MAX_CONSECUTIVE_STRETCH = 2

_BEHAVIOURAL_POOL_SIZE = {'familiar': 15, 'balanced': 8, 'explore': 3}


def _anchor_influence(session_length):
    if session_length <= 5:
        return _ANCHOR_INFLUENCE_EARLY
    if session_length <= 15:
        return _ANCHOR_INFLUENCE_MID
    return _ANCHOR_INFLUENCE_LATE


def classify_skip(position_pct):
    """PRD section 32: distinguish an early skip (likely rejection --
    strong negative signal) from a mid-track skip (weak negative) from a
    late skip (essentially neutral -- the listener probably just wanted the
    next song, not a rejection of this one)."""
    if position_pct is None:
        return 'neutral'
    if position_pct < 0.25:
        return 'reject'
    if position_pct < 0.75:
        return 'weak_negative'
    return 'neutral'


def adaptive_discovery_mode(recent_skip_classifications, base_mode):
    """PRD section 28: widen tolerance slightly after accepted exploration
    (handled implicitly -- no recent rejects means we stay at the
    requested mode), narrow it (pull back toward the anchor) after
    repeated early-skip rejections of what was just offered."""
    rejects = list(recent_skip_classifications or []).count('reject')
    if rejects >= 2:
        return 'familiar'
    if rejects == 1 and base_mode == 'explore':
        return 'balanced'
    return base_mode


def build_session_vector(similarity_index, recent_track_ids, manual_track_ids):
    """Rolling session centroid (PRD section 26): recent tracks weighted
    exponentially more than older ones; manual selections weighted extra,
    since the listener choosing a track themselves is a stronger steering
    signal than the engine's own prior pick (PRD section 25/58)."""
    if not recent_track_ids:
        return None, None
    space = None
    weighted_sum = None
    total_weight = 0.0
    n = len(recent_track_ids)
    for i, tid in enumerate(recent_track_ids):
        s, vec = similarity_index.get_vector(tid)
        if vec is None:
            continue
        if space is None:
            space = s
        elif s != space:
            continue  # only blend vectors from one consistent signal space
        recency_rank = n - 1 - i  # 0 = most recent
        weight = 0.8 ** recency_rank
        if tid in manual_track_ids:
            weight *= 1.6
        weighted_sum = vec * weight if weighted_sum is None else weighted_sum + vec * weight
        total_weight += weight
    if weighted_sum is None or total_weight <= 0:
        return None, None
    centroid = weighted_sum / total_weight
    norm = float((centroid ** 2).sum() ** 0.5)
    if norm > 1e-8:
        centroid = centroid / norm
    return space, centroid


def _score_candidates(candidate_ids, similarity_index, anchor_id, current_id, session_vec, session_space,
                       anchor_influence, library_by_id, play_stats_by_id, favourite_ids, repetition,
                       discovery_mode, thresholds, allow_stretch, category_counts, total_recent):
    anchor_weight = _ANCHOR_WEIGHT_BASE * (anchor_influence / _ANCHOR_INFLUENCE_EARLY)
    session_weight = 0.30 + (_ANCHOR_WEIGHT_BASE - anchor_weight)  # conserve total weight as anchor decays

    scored = []
    for tid in candidate_ids:
        if repetition.is_hard_excluded(tid):
            continue
        track = library_by_id[tid]

        current_sim = similarity_index.similarity(current_id, tid) or 0.0
        session_sim = current_sim
        if session_vec is not None:
            s = similarity_index.similarity_to_vector(session_vec, session_space, tid)
            if s is not None:
                session_sim = s
        anchor_sim = (similarity_index.similarity(anchor_id, tid) if anchor_id else None)
        if anchor_sim is None:
            anchor_sim = session_sim

        stats = play_stats_by_id.get(tid, {})
        # Relevance gate (PRD section 10/42) -- session similarity is the
        # relevance proxy here, same principle as Genius's theme_fit gate.
        if not discovery.passes_relevance_gate(session_sim, stats):
            continue

        is_favourite = tid in favourite_ids
        category = discovery.discovery_category(stats, is_favourite, thresholds=thresholds)
        if category == 'stretch' and not allow_stretch:
            continue  # PRD section 30: don't stack a 3rd exploration track in a row

        transition = 0.7 * current_sim + 0.3 * genre_continuity(library_by_id.get(current_id), track)

        plays = int(stats.get('plays') or 0)
        skips = int(stats.get('skips') or 0)
        completions = int(stats.get('completions') or 0)
        last_played = stats.get('last_played')
        skip_rate = skips / plays if plays else 0.0
        completion_rate = completions / plays if plays else 0.5
        personal_affinity = clamp(0.5 + 0.35 * completion_rate - 0.3 * skip_rate, 0.0, 1.0)
        if is_favourite:
            personal_affinity = clamp(personal_affinity + 0.15, 0.0, 1.0)
        freshness = 1.0 if not last_played else clamp((time.time() - last_played) / (365 * 86400.0), 0.0, 1.0)

        dv = discovery.discovery_value(stats, is_favourite, thresholds=thresholds)
        budget = discovery.budget_bonus(category, discovery_mode, category_counts, total_recent)

        artist_key = norm_key(track.get('artist'))
        album_key = norm_key(track.get('album'))
        penalty = repetition.penalty_for(tid, artist_key, album_key, last_played)

        score = (
            session_weight * session_sim
            + 0.20 * current_sim
            + anchor_weight * anchor_sim
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
                'session_similarity': round(session_sim, 4),
                'current_similarity': round(current_sim, 4),
                'anchor_similarity': round(anchor_sim, 4),
                'discovery_value': round(dv, 4),
                'discovery_category': category,
                'repetition_penalty': round(penalty, 4),
                'never_played': int(stats.get('valid_plays') or 0) == 0,
            },
        })
    return scored


def generate_continuous_next(
    similarity_index,
    recent_track_ids,           # session history so far, chronological, most recent last
    manual_track_ids,            # subset of recent_track_ids the listener picked themselves
    original_seed_ids,            # what started the session (PRD section 25) -- track/album/playlist origin
    current_track_id,
    library_by_id,
    play_stats_by_id,
    favourite_ids,
    recent_skip_classifications=None,   # ['reject'|'weak_negative'|'neutral', ...] for the last few skips
    recent_generated_categories=None,    # discovery categories of the last few *generated* (non-manual) tracks in a row
    exclude_track_ids=None,
    limit=3,
    discovery_mode='balanced',
    rng_seed=None,
):
    """Generate the next `limit` tracks for Continuous Play. Returns a list
    of dicts: {track_id, score, category, explanation} -- the small
    lookahead queue PRD section 55 describes, not a full playlist."""
    rng = random.Random(rng_seed if rng_seed is not None else time.time_ns())
    if discovery_mode not in discovery.DISCOVERY_MODE_BUDGETS:
        discovery_mode = 'balanced'

    manual_set = set(manual_track_ids or ())
    recent_track_ids = [tid for tid in (recent_track_ids or []) if tid in library_by_id]
    thresholds = discovery.compute_library_thresholds(play_stats_by_id)
    effective_mode = adaptive_discovery_mode(recent_skip_classifications, discovery_mode)

    anchor_id = None
    for candidate in (original_seed_ids or []):
        if candidate in library_by_id:
            anchor_id = candidate
            break
    if anchor_id is None and recent_track_ids:
        anchor_id = recent_track_ids[0]
    if anchor_id is None:
        anchor_id = current_track_id if current_track_id in library_by_id else None

    session_space, session_vec = build_session_vector(similarity_index, recent_track_ids, manual_set)
    anchor_influence = _anchor_influence(len(recent_track_ids))

    consecutive_stretch = 0
    for cat in reversed(recent_generated_categories or []):
        if cat == 'stretch':
            consecutive_stretch += 1
        else:
            break

    repetition = RepetitionState()
    for tid in recent_track_ids[-6:]:
        track = library_by_id.get(tid)
        if track:
            repetition.record(tid, norm_key(track.get('artist')), norm_key(track.get('album')))

    seed_ids_for_pool = list(dict.fromkeys([sid for sid in ([anchor_id] if anchor_id else []) + [current_track_id] if sid]))
    hard_exclude = set(exclude_track_ids or ()) | set(recent_track_ids)
    played_ids = {tid for tid, s in play_stats_by_id.items() if int(s.get('plays') or 0) > 0}

    # Discovery-mode budget bookkeeping (PRD section 15/52), seeded from
    # whatever category history the client has for this session so far --
    # the same soft nudge Genius Playlist uses, applied to the live queue.
    category_counts = {'familiar': 0, 'rediscovery': 0, 'stretch': 0}
    for cat in (recent_generated_categories or []):
        if cat in category_counts:
            category_counts[cat] += 1
    total_recent = sum(category_counts.values())

    results = []
    walking_current = current_track_id
    for _ in range(max(1, limit)):
        allow_stretch = consecutive_stretch < _MAX_CONSECUTIVE_STRETCH
        candidate_pool = build_candidate_pool(
            similarity_index, seed_ids_for_pool, walking_current, session_vec, session_space,
            library_by_id, hard_exclude_ids=hard_exclude,
        )
        # Behavioural-neighbour source (PRD section 16), same rationale as
        # Genius Playlist -- ensures Familiar/Balanced modes have real
        # played-track candidates, not just a scoring nudge with nothing to
        # act on in a library where most tracks are still unheard.
        remaining_played = played_ids - hard_exclude - candidate_pool
        if remaining_played and anchor_id:
            top_n = _BEHAVIOURAL_POOL_SIZE.get(effective_mode, 8)
            ranked = sorted(remaining_played,
                             key=lambda tid: -(similarity_index.similarity(anchor_id, tid) or -1.0))[:top_n]
            candidate_pool = candidate_pool | set(ranked)
        if not candidate_pool:
            break

        scored = _score_candidates(
            candidate_pool, similarity_index, anchor_id, walking_current, session_vec, session_space,
            anchor_influence, library_by_id, play_stats_by_id, favourite_ids, repetition,
            effective_mode, thresholds, allow_stretch, category_counts, total_recent,
        )
        if not scored and not allow_stretch:
            # Relax the stretch cap rather than dead-end the queue entirely.
            scored = _score_candidates(
                candidate_pool, similarity_index, anchor_id, walking_current, session_vec, session_space,
                anchor_influence, library_by_id, play_stats_by_id, favourite_ids, repetition,
                effective_mode, thresholds, True, category_counts, total_recent,
            )
        scored.sort(key=lambda c: c['score'], reverse=True)
        chosen = weighted_sample(scored, rng, band_size=10, temperature=0.10)
        if chosen is None:
            break

        track = library_by_id[chosen['track_id']]
        repetition.record(chosen['track_id'], norm_key(track.get('artist')), norm_key(track.get('album')))
        hard_exclude.add(chosen['track_id'])
        results.append({
            'track_id': chosen['track_id'], 'score': round(chosen['score'], 4),
            'category': chosen['category'], 'explanation': chosen['explanation'],
        })

        consecutive_stretch = consecutive_stretch + 1 if chosen['category'] == 'stretch' else 0
        category_counts[chosen['category']] = category_counts.get(chosen['category'], 0) + 1
        total_recent += 1
        walking_current = chosen['track_id']
        if session_vec is not None:
            chosen_space, chosen_vec = similarity_index.get_vector(chosen['track_id'])
            if chosen_space == session_space and chosen_vec is not None:
                session_vec = 0.75 * session_vec + 0.25 * chosen_vec
                norm = float((session_vec ** 2).sum() ** 0.5)
                if norm > 1e-8:
                    session_vec = session_vec / norm

    return results
