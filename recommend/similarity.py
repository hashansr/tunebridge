"""
Track-to-track sonic similarity for Genius Playlist / Continuous Play.

Primary signal: PANNs CNN14 embeddings (recommend/embedder.py), loaded into
an in-memory NumPy matrix for brute-force cosine similarity / k-NN. At
TuneBridge's library scale (thousands, not millions, of tracks) this is
sub-10ms -- no ANN index (FAISS/Annoy) is needed; nearest_neighbors() is a
clean-enough interface that one could be dropped in later without touching
callers, if the library ever grows enough to warrant it.

Fallback signal: when a track has no embedding yet (analysis pending or
failed), fall back to the existing 13-band FFT band_energy cosine -- the
same signal IEM Match's genre fingerprinting already computes from
track_features -- so every track always has *some* similarity signal, per
the PRD's cold-start / partial-analysis principle (a track never blocks on
"no data available", it just gets a coarser signal until analysed).
"""

import numpy as np


class SimilarityIndex:
    """In-memory cosine-similarity index over track embeddings, with an FFT-band fallback."""

    def __init__(self, embedding_entries, feature_entries, embedding_version=None, analysis_version=None):
        """
        embedding_entries: list of dicts from db.db_load_embedding_entries()
            (track_id, vector: np.ndarray|None, failed, embedding_version)
        feature_entries: list of dicts from db.db_load_feature_entries()
            (track_id, band_energy: list|None, failed, analysis_version)
        embedding_version / analysis_version: when given, entries whose stored
            version doesn't match are excluded -- so once either pipeline's
            version bumps (as ANALYSIS_VERSION already has, v1->v4), stale
            vectors from an older model/feature-set are never silently reused
            for similarity, they're just treated as not-yet-analysed until
            reprocessed. Pass None to skip the check (accept any version).
        """
        self._deep_ids = []
        deep_vecs = []
        for e in embedding_entries:
            v = e.get('vector')
            if (v is not None and not e.get('failed') and len(v) > 0
                    and (embedding_version is None or e.get('embedding_version') == embedding_version)):
                self._deep_ids.append(e['track_id'])
                deep_vecs.append(v)
        self._deep_matrix = _stack_and_normalize(deep_vecs)
        self._deep_index = {tid: i for i, tid in enumerate(self._deep_ids)}

        self._fft_ids = []
        fft_vecs = []
        for e in feature_entries:
            band = e.get('band_energy')
            if (band and not e.get('failed') and len(band) > 0
                    and (analysis_version is None or e.get('analysis_version') == analysis_version)):
                self._fft_ids.append(e['track_id'])
                fft_vecs.append(band)
        self._fft_matrix = _stack_and_normalize(fft_vecs)
        self._fft_index = {tid: i for i, tid in enumerate(self._fft_ids)}

    def deep_matrix_and_ids(self):
        """Return (matrix, ids) for the deep (PANNs) embedding space -- the
        same L2-normalized matrix used internally for similarity/k-NN, exposed
        for other consumers (e.g. Sonic Profile's KMeans/PCA clustering) that
        need direct matrix access rather than pairwise queries."""
        return self._deep_matrix, self._deep_ids

    def has_deep_embedding(self, track_id):
        return track_id in self._deep_index

    def signal_for(self, track_id):
        """Return 'deep' | 'fft' | None -- which similarity signal is available for this track."""
        if track_id in self._deep_index:
            return 'deep'
        if track_id in self._fft_index:
            return 'fft'
        return None

    def similarity(self, track_id_a, track_id_b):
        """Cosine similarity, preferring the deep-embedding space when both
        tracks have one; falls back to the FFT-band space otherwise.
        Returns None if neither track has any usable signal in common."""
        if track_id_a in self._deep_index and track_id_b in self._deep_index:
            va = self._deep_matrix[self._deep_index[track_id_a]]
            vb = self._deep_matrix[self._deep_index[track_id_b]]
            return float(np.dot(va, vb))
        if track_id_a in self._fft_index and track_id_b in self._fft_index:
            va = self._fft_matrix[self._fft_index[track_id_a]]
            vb = self._fft_matrix[self._fft_index[track_id_b]]
            return float(np.dot(va, vb))
        return None

    def get_vector(self, track_id):
        """Return (space, normalized_vector) for a track -- ('deep'|'fft', np.ndarray) --
        preferring the deep space, or (None, None) if the track has neither.
        Used by Genius Playlist / Continuous Play to build running centroids
        (session average, anchor) in the same vector space as the seed."""
        if track_id in self._deep_index:
            return 'deep', self._deep_matrix[self._deep_index[track_id]]
        if track_id in self._fft_index:
            return 'fft', self._fft_matrix[self._fft_index[track_id]]
        return None, None

    def similarity_to_vector(self, vector, space, track_id):
        """Cosine similarity between an arbitrary (already L2-normalized)
        vector in the given space and a specific track's vector in that same
        space. Returns None if the track has no vector in that space."""
        if space == 'deep' and track_id in self._deep_index:
            return float(np.dot(vector, self._deep_matrix[self._deep_index[track_id]]))
        if space == 'fft' and track_id in self._fft_index:
            return float(np.dot(vector, self._fft_matrix[self._fft_index[track_id]]))
        return None

    def nearest_neighbors(self, track_id, k=20, exclude_ids=None):
        """Return up to k (track_id, score) pairs, sorted descending by
        cosine score. Uses the seed's deep embedding if it has one, else
        falls back to its FFT-band vector. Returns [] if the seed has
        neither."""
        exclude = set(exclude_ids or ())
        exclude.add(track_id)

        if track_id in self._deep_index:
            ids, matrix, idx_map = self._deep_ids, self._deep_matrix, self._deep_index
        elif track_id in self._fft_index:
            ids, matrix, idx_map = self._fft_ids, self._fft_matrix, self._fft_index
        else:
            return []

        seed_vec = matrix[idx_map[track_id]]
        return self._nearest_in_space(seed_vec, ids, matrix, k, exclude)

    def nearest_neighbors_to_vector(self, vector, space, k=20, exclude_ids=None):
        """Like nearest_neighbors(), but seeded from an arbitrary vector
        (e.g. a running session centroid) rather than one specific track."""
        exclude = set(exclude_ids or ())
        if space == 'deep':
            ids, matrix = self._deep_ids, self._deep_matrix
        elif space == 'fft':
            ids, matrix = self._fft_ids, self._fft_matrix
        else:
            return []
        return self._nearest_in_space(vector, ids, matrix, k, exclude)

    @staticmethod
    def _nearest_in_space(seed_vec, ids, matrix, k, exclude):
        if matrix.size == 0:
            return []
        scores = matrix @ seed_vec  # cosine, since rows are L2-normalized
        order = np.argsort(-scores)
        results = []
        for i in order:
            tid = ids[i]
            if tid in exclude:
                continue
            results.append((tid, float(scores[i])))
            if len(results) >= k:
                break
        return results


def _stack_and_normalize(vectors):
    if not vectors:
        return np.zeros((0, 0), dtype=np.float32)
    matrix = np.array(vectors, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms < 1e-8] = 1.0
    return matrix / norms
