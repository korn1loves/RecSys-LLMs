// Shared parsing + recommendation logic, used by BOTH the browser app
// (data.js / script.js) and the offline analysis script (analysis.js).
// Keeping the formulas here in one place means the app and the analysis
// script can never silently drift apart and compute something different.
(function (root) {
    'use strict';

    // The 18 named genre columns in u.item, in file order. The raw
    // "unknown" flag (u.item field 6, i.e. index 5) is deliberately not a
    // genre and is dropped before this list is used.
    const GENRE_NAMES = [
        "Action", "Adventure", "Animation", "Children's", "Comedy",
        "Crime", "Documentary", "Drama", "Fantasy", "Film-Noir",
        "Horror", "Musical", "Mystery", "Romance", "Sci-Fi",
        "Thriller", "War", "Western"
    ];

    // u.item is pipe-delimited with 24 fields per line:
    //   0 id | 1 title | 2 release date | 3 video release date | 4 IMDb URL |
    //   5 "unknown" genre flag | 6..23 the 18 named genre flags (Action..Western)
    const GENRE_FLAGS_START = 6;

    function parseItemData(text) {
        const movies = [];

        for (const line of text.split('\n')) {
            if (line.trim() === '') continue;

            const fields = line.split('|');
            if (fields.length < GENRE_FLAGS_START + GENRE_NAMES.length) continue;

            const id = parseInt(fields[0], 10);
            const title = fields[1];
            const flags = fields.slice(GENRE_FLAGS_START, GENRE_FLAGS_START + GENRE_NAMES.length);
            const vector = flags.map(value => (value === '1' ? 1 : 0));
            const genres = GENRE_NAMES.filter((_, index) => vector[index] === 1);

            movies.push({ id, title, genres, vector });
        }

        return movies;
    }

    function parseRatingData(text) {
        const ratings = [];

        for (const line of text.split('\n')) {
            if (line.trim() === '') continue;

            const fields = line.split('\t');
            if (fields.length < 4) continue;

            const userId = parseInt(fields[0], 10);
            const itemId = parseInt(fields[1], 10);
            const rating = parseFloat(fields[2]);
            const timestamp = parseInt(fields[3], 10);

            ratings.push({ userId, itemId, rating, timestamp });
        }

        return ratings;
    }

    // One pass over ratings -> Map(itemId -> { count, avg }). This is the
    // popularity signal used as a tie-break below.
    function computeMovieStats(ratings) {
        const sums = new Map();

        for (const r of ratings) {
            const entry = sums.get(r.itemId) || { count: 0, sum: 0 };
            entry.count += 1;
            entry.sum += r.rating;
            sums.set(r.itemId, entry);
        }

        const stats = new Map();
        for (const [itemId, entry] of sums) {
            stats.set(itemId, { count: entry.count, avg: entry.sum / entry.count });
        }
        return stats;
    }

    function getStats(statsMap, itemId) {
        return statsMap.get(itemId) || { count: 0, avg: 0 };
    }

    // Cosine similarity between two equal-length numeric vectors.
    // A zero-magnitude vector (a movie with no recognized genre — e.g.
    // u.item ids 267 and 1373, which carry only the raw "unknown" flag)
    // always scores 0 against everything instead of producing NaN.
    function cosineSimilarity(a, b) {
        let dot = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Elementwise mean of several genre vectors — the "taste profile" for
    // a user defined by N watched movies.
    function buildProfileVector(vectors) {
        const length = GENRE_NAMES.length;
        const sum = new Array(length).fill(0);

        for (const vector of vectors) {
            for (let i = 0; i < length; i++) sum[i] += vector[i];
        }

        return sum.map(value => value / vectors.length);
    }

    // Score every movie in `allMovies` (except ids in `excludeIds`) against
    // `queryVector`, then rank by:
    //   1. cosine score, descending;
    //   2. rating count from u.data, descending — a deliberate popularity
    //      signal (not an accident of array order) used to break ties
    //      between equally-similar movies. Its effect on long-tail catalog
    //      exposure is intended to be measured, not assumed benign — see
    //      the long-tail check in analysis.js;
    //   3. average rating, descending;
    //   4. movie id, ascending — final deterministic fallback.
    function rankCandidates(allMovies, queryVector, statsMap, excludeIds, topN) {
        const scored = allMovies
            .filter(movie => !excludeIds.has(movie.id))
            .map(movie => ({
                ...movie,
                score: cosineSimilarity(queryVector, movie.vector),
                stats: getStats(statsMap, movie.id)
            }));

        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.stats.count !== a.stats.count) return b.stats.count - a.stats.count;
            if (b.stats.avg !== a.stats.avg) return b.stats.avg - a.stats.avg;
            return a.id - b.id;
        });

        return scored.slice(0, topN);
    }

    const api = {
        GENRE_NAMES,
        parseItemData,
        parseRatingData,
        computeMovieStats,
        cosineSimilarity,
        buildProfileVector,
        rankCandidates
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.Recommender = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
