"""
Discovery Value scoring for Genius Playlist / Continuous Play
(PRD "Genius & Continuous Discovery" section 10: Discovery Score).

Every candidate receives a Discovery Value reflecting how much it
represents "music the user owns but isn't engaging with" -- unheard,
underplayed, forgotten, or a favourite that's gone quiet.

Critically, this is computed *separately* from musical relevance and is
NOT allowed to rescue an irrelevant candidate (section 10 is explicit about
this -- the failure mode to avoid is `badRecommendation + hugeNoveltyBonus
= selected`). Callers must apply `passes_relevance_gate()` first and only
let Discovery Value influence ranking for candidates that already clear it.
"""

import time

DAY = 86400.0

# PRD section 15 -- soft budget targets per Discovery mode, not hard quotas.
# 'familiar' / 'rediscovery' / 'stretch' mirror the PRD's own vocabulary
# (section 15: Familiar / Rediscovery / Stretch).
DISCOVERY_MODE_BUDGETS = {
    'familiar': {'familiar': 0.75, 'rediscovery': 0.20, 'stretch': 0.05},
    'balanced': {'familiar': 0.60, 'rediscovery': 0.28, 'stretch': 0.12},
    'explore':  {'familiar': 0.35, 'rediscovery': 0.35, 'stretch': 0.30},
}

# PRD section 42: an unheard track needs a materially higher relevance bar
# before it's eligible at all -- prevents the engine from using the user's
# least-played songs as random filler.
UNHEARD_RELEVANCE_FLOOR = 0.55
DEFAULT_RELEVANCE_FLOOR = 0.35

FORGOTTEN_DAYS = 180          # "not played for a long time" (~6 months)
DEFAULT_UNDERPLAYED_MAX_PLAYS = 3   # fallback only -- prefer compute_library_thresholds()
RECENT_WEEK_DAYS = 7
FAVOURITE_QUIET_DAYS = 60


def _days_since_played(stats):
    last_played = stats.get('last_played')
    return (time.time() - last_played) / DAY if last_played else None


def compute_library_thresholds(play_stats_by_id):
    """Derive an adaptive 'underplayed' bar from this library's own
    play-count distribution, instead of one fixed number (PRD section 8:
    "do not permanently use one fixed formula... weight according to
    confidence"). A library where play tracking just started (max play
    count in the single digits) needs a very different "familiar" bar than
    one with years of tracked listening -- a hardcoded threshold like "3
    plays" would make almost nothing "familiar" in the former case, and
    almost everything "familiar" in the latter."""
    play_counts = sorted(int(s.get('plays') or 0) for s in (play_stats_by_id or {}).values()
                          if int(s.get('plays') or 0) > 0)
    if not play_counts:
        return {'underplayed_max_plays': DEFAULT_UNDERPLAYED_MAX_PLAYS}
    # 60th percentile of tracks that have been played at all becomes the
    # "familiar" bar -- scales naturally as tracked history accumulates.
    idx = min(int(len(play_counts) * 0.6), len(play_counts) - 1)
    return {'underplayed_max_plays': max(1, play_counts[idx])}


def discovery_category(stats, is_favourite, thresholds=None):
    """Classify a candidate for budget bookkeeping: 'familiar' | 'rediscovery' | 'stretch'.
    'stretch' = genuinely unheard or long-forgotten; 'rediscovery' =
    underplayed, or a favourite that's gone quiet; 'familiar' = everything
    else (regularly played, relative to this library's own play-count
    distribution -- see compute_library_thresholds())."""
    thresholds = thresholds or {}
    underplayed_max = thresholds.get('underplayed_max_plays', DEFAULT_UNDERPLAYED_MAX_PLAYS)
    plays = int(stats.get('plays') or 0)
    valid_plays = int(stats.get('valid_plays') or 0)
    days_since = _days_since_played(stats)

    if valid_plays == 0:
        return 'stretch'
    if days_since is not None and days_since >= FORGOTTEN_DAYS:
        return 'stretch'
    if is_favourite and days_since is not None and days_since >= FAVOURITE_QUIET_DAYS:
        return 'rediscovery'
    if plays <= underplayed_max:
        return 'rediscovery'
    return 'familiar'


def discovery_value(stats, is_favourite, recently_recommended_repeat_count=0, thresholds=None):
    """Discovery Value, roughly in [0, ~1.3] -- higher means more worth
    surfacing as a rediscovery/stretch pick. Combines the PRD section 10
    signals: never played (large bonus), played rarely (moderate bonus),
    forgotten (moderate-large bonus), played frequently this week
    (penalty), recently recommended repeatedly (strong penalty), favourite
    but quiet (moderate rediscovery bonus)."""
    thresholds = thresholds or {}
    underplayed_max = thresholds.get('underplayed_max_plays', DEFAULT_UNDERPLAYED_MAX_PLAYS)
    plays = int(stats.get('plays') or 0)
    valid_plays = int(stats.get('valid_plays') or 0)
    days_since = _days_since_played(stats)

    value = 0.5  # baseline -- an average, unremarkable track

    if valid_plays == 0:
        value += 0.40
    elif plays <= underplayed_max:
        value += 0.20

    if days_since is not None:
        if days_since >= FORGOTTEN_DAYS:
            value += 0.25
        elif days_since <= RECENT_WEEK_DAYS and plays >= 3:
            value -= 0.30  # played frequently this week -- not a discovery moment

    if is_favourite and (days_since is None or days_since >= FAVOURITE_QUIET_DAYS):
        value += 0.15

    if recently_recommended_repeat_count > 0:
        value -= 0.5 * min(recently_recommended_repeat_count, 3)

    return max(0.0, value)


def passes_relevance_gate(relevance_score, stats):
    """PRD sections 10 + 42: relevance must clear a minimum bar before
    Discovery Value is allowed to influence ranking at all -- and an
    unheard track needs a materially higher bar than a familiar one."""
    valid_plays = int(stats.get('valid_plays') or 0)
    floor = UNHEARD_RELEVANCE_FLOOR if valid_plays == 0 else DEFAULT_RELEVANCE_FLOOR
    return relevance_score >= floor


def budget_bonus(category, mode, category_counts, total_placed):
    """Soft nudge (not a hard quota, PRD section 15) toward the target
    familiar/rediscovery/stretch mix for the given Discovery mode: positive
    when `category` is currently under-represented in what's been placed
    so far, negative when it's over-represented."""
    budgets = DISCOVERY_MODE_BUDGETS.get(mode, DISCOVERY_MODE_BUDGETS['balanced'])
    target_frac = budgets.get(category, 0.0)
    current_frac = category_counts.get(category, 0) / total_placed if total_placed else 0.0
    return 0.08 * (target_frac - current_frac)
