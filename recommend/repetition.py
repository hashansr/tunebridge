"""
Shared repetition-protection windows for Genius Playlist / Continuous Play
(PRD "Genius & Continuous Discovery" section 11: Repetition Protection).

Both features build a sequence of tracks incrementally (Genius walks a fixed-
length arc; Continuous Play extends a live queue), so both need the exact
same "what have we recently used" bookkeeping -- kept here as one shared
class so the two features can't independently drift out of sync on what
counts as "too soon to repeat."

Default windows, straight from the PRD:
    same recording          -- never repeat within the session
    same track (by play history, not just this session) -- strong penalty if played within 7 days
    same artist              -- avoid within the previous 4 generated tracks
    same album                -- avoid within the previous 6 generated tracks
    recently recommended but skipped -- suppress aggressively
"""

import time

SAME_TRACK_RECENT_PLAY_DAYS = 7
ARTIST_LOOKBACK = 4
ALBUM_LOOKBACK = 6
SKIPPED_SUPPRESSION_PENALTY = 0.6   # subtracted from score, not a hard exclude
RECENT_PLAY_PENALTY = 0.25          # subtracted when played within SAME_TRACK_RECENT_PLAY_DAYS

# Rolling-window artist-share soft cap: separate from the proximity-decay
# penalty above -- ARTIST_LOOKBACK alone resets to zero once an artist has
# been absent for a few tracks, which doesn't stop one artist dominating a
# whole queue (e.g. reappearing every ~5th slot indefinitely). This caps
# an artist's *total* share of the trailing window instead.
ARTIST_SHARE_WINDOW = 10          # trailing N placed tracks the share cap looks at
ARTIST_SHARE_MAX_FRACTION = 0.30  # max allowed fraction of that window from one artist
ARTIST_SHARE_CAP_COUNT = int(ARTIST_SHARE_WINDOW * ARTIST_SHARE_MAX_FRACTION)  # = 3
ARTIST_SHARE_PENALTY = 0.45       # heavy additive penalty once the cap is reached (soft, not hard-exclude)


class RepetitionState:
    """Tracks what's already been placed in the current generation/session,
    so callers can hard-exclude exact repeats and soft-penalize near
    repeats (same artist/album too recently, tracks the user skipped when
    previously recommended)."""

    def __init__(self, skipped_recently_recommended_ids=None):
        self._placed_ids = []          # in placement order, full history for this run
        self._artist_history = []      # parallel list of artist keys
        self._album_history = []       # parallel list of album keys
        self._skipped_ids = set(skipped_recently_recommended_ids or ())

    def record(self, track_id, artist_key, album_key):
        self._placed_ids.append(track_id)
        self._artist_history.append(artist_key)
        self._album_history.append(album_key)

    def is_hard_excluded(self, track_id):
        """Same recording already placed this session -- never repeat."""
        return track_id in self._placed_ids

    def penalty_for(self, track_id, artist_key, album_key, last_played_at=None):
        """Soft penalty (0 = no penalty) for a candidate, based on how
        recently the same artist/album appeared, whether it was skipped
        when previously recommended, and whether it was played very
        recently outside this session."""
        penalty = 0.0

        if artist_key:
            recent_artists = self._artist_history[-ARTIST_LOOKBACK:]
            if artist_key in recent_artists:
                # Closer repeats hurt more than one right at the edge of the window.
                distance_from_end = len(recent_artists) - recent_artists[::-1].index(artist_key)
                closeness = 1.0 - (distance_from_end - 1) / max(1, ARTIST_LOOKBACK)
                penalty += 0.35 * closeness

        if artist_key:
            share_window = self._artist_history[-ARTIST_SHARE_WINDOW:]
            if share_window.count(artist_key) >= ARTIST_SHARE_CAP_COUNT:
                penalty += ARTIST_SHARE_PENALTY

        if album_key:
            recent_albums = self._album_history[-ALBUM_LOOKBACK:]
            if album_key in recent_albums:
                distance_from_end = len(recent_albums) - recent_albums[::-1].index(album_key)
                closeness = 1.0 - (distance_from_end - 1) / max(1, ALBUM_LOOKBACK)
                penalty += 0.20 * closeness

        if track_id in self._skipped_ids:
            penalty += SKIPPED_SUPPRESSION_PENALTY

        if last_played_at:
            days_since = (time.time() - last_played_at) / 86400.0
            if 0 <= days_since < SAME_TRACK_RECENT_PLAY_DAYS:
                penalty += RECENT_PLAY_PENALTY * (1.0 - days_since / SAME_TRACK_RECENT_PLAY_DAYS)

        return penalty
