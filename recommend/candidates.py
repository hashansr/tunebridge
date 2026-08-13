"""
Shared candidate-pool assembly for Genius Playlist / Continuous Play
(PRD "Genius & Continuous Discovery" section 16: combine several sources,
deduplicate, apply hard exclusions -- so no single information source
dominates the pool).
"""


def build_candidate_pool(similarity_index, seed_ids, current_track_id, session_vector, session_space,
                          library_by_id, hard_exclude_ids, per_source_k=None):
    """
    Combine the pure-similarity sources from PRD section 16 into one
    deduplicated candidate pool of track_ids:
        - nearest to the primary seed(s)
        - nearest to the current/last-placed track
        - nearest to the running session centroid

    Behavioural-neighbour and underexposed-taste-region sources (the other
    two PRD section 16 sources) are layered in by discovery-aware callers
    that have play-history access (recommend/discovery.py, Phase 3) -- this
    function only handles similarity-graph sources so it stays reusable by
    both Genius Playlist and Continuous Play.

    Returns a set of track_ids (deduplicated, hard exclusions already applied).
    """
    per_source_k = per_source_k or {'seed': 50, 'current': 40, 'session': 30}
    exclude = set(hard_exclude_ids or ())
    pool = set()

    for seed_id in seed_ids:
        for tid, _score in similarity_index.nearest_neighbors(seed_id, k=per_source_k['seed'], exclude_ids=exclude):
            if tid in library_by_id:
                pool.add(tid)

    if current_track_id and current_track_id not in seed_ids:
        for tid, _score in similarity_index.nearest_neighbors(current_track_id, k=per_source_k['current'], exclude_ids=exclude):
            if tid in library_by_id:
                pool.add(tid)

    if session_vector is not None and session_space:
        for tid, _score in similarity_index.nearest_neighbors_to_vector(
            session_vector, session_space, k=per_source_k['session'], exclude_ids=exclude
        ):
            if tid in library_by_id:
                pool.add(tid)

    pool -= exclude
    return pool
