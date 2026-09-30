// ---------------------------------------------------------------------------
// HW3 -- Collaborative Filtering core
//
// Missing-value strategy (see week3/readme.md section 6): weighted by the
// number of co-rated items.
//
//   [x] weight similarity by the number of co-rated items
//
// cosineSimilarity(a, b) below returns the raw co-rated-only cosine. Every
// caller that ranks or predicts with it applies weightedSimilarity(a, b)
// instead, which multiplies that raw cosine by min(n, 50) / 50, n = number
// of co-rated items. This matters on this dataset specifically: two users
// (or two movies) with exactly one rating in common get raw cosine == 1.0
// 100% of the time (trivially -- a single positive number is always
// "parallel" to another single positive number), and the *average* raw
// cosine across all 429,110 user pairs that share at least one rating is
// 0.9445 regardless of how many items they share (0.9391 at n=5,
// 0.9437 at n>=50) -- ratings are 1-5 only, so nearly every pair of
// positive vectors points the same direction and raw cosine is close to 1
// almost everywhere.
//
// This is MITIGATED, not fixed, by the min(n,50)/50 weighting -- and only
// for one specific problem: which OTHER USERS/ITEMS get selected and
// ranked as neighbors (getTopUserNeighbors / the item-item cache), where a
// weight of 0.02 at n=1 genuinely can't outrank a weight near 0.94-1.0 at
// n>=50. Because raw cosine varies so little (0.94-1.0) while min(n,50)/50
// varies a lot (0.02-1.0), weighted similarity is almost entirely a
// function of n -- run `node analysis.js` for the actual correlation. Raw
// cosine itself is doing very little discriminative work here.
//
// It does NOT fix, and structurally cannot fix, a different problem: an
// item's own BASELINE (its mean rating, used in predictItemBased) is not
// touched by similarity weighting at all. A movie with one 5-star rating
// has baseline = 5.0 regardless of how any neighbor's similarity is
// weighted -- that's addressed separately below with MIN_ITEM_RATINGS /
// MIN_NEIGHBOURS, a minimum-support filter on candidates, not a similarity
// adjustment. (An earlier pass over this file claimed the weighting alone
// suppressed sparse-item promotion into Top-5; measured against real data,
// it doesn't -- see analysis.js's before/after MIN_ITEM_RATINGS section.)
//
// Deviation from the readme's literal signature: section 5.3 describes
// cosineSimilarity(a, b) as taking "two arrays... slice the rating matrix
// column or row". Slicing a dense 1683- or 944-length row/column for every
// comparison is the exact perf problem this file avoids -- see the caching
// note above getUserBasedRecommendations / buildItemSimilarityCache below.
// cosineSimilarity here instead takes two sparse Map<id, rating> "vectors"
// (rows/columns of userRatings / itemRatings from data.js), which is the
// same co-rated-only computation, just without materializing zeros.
//
// Deviation from the readme's prediction formula: section 5.4/5.5 describe
// the predicted score as a plain similarity-weighted average of neighbors'
// raw ratings (no baseline). This file uses the mean-centered formula from
// the lecture instead: predicted = baseline + sum(w * (r - mean)) / sum(|w|)
// (see aggregate() below), baseline = the active user's own mean rating
// (user-based) or the target movie's own mean rating (item-based), over
// neighbors with positive similarity only, top N = 20, clamped to [1, 5]
// (see predictUserBased / predictItemBased -- clamping is required:
// baseline and each neighbor's deviation come from different users'/items'
// own means, so nothing in the unclamped formula guarantees the sum stays
// inside the 1-5 rating scale; measured on real data, an unclamped run
// puts 3.04% of predictions outside [1, 5], as far out as -0.55 to 6.90).
//
// MIN_ITEM_RATINGS / MIN_NEIGHBOURS below are an additional minimum-support
// gate, separate from the weighting above, applied only when ranking Top-5
// candidates -- see the comment on those constants.
// ---------------------------------------------------------------------------

const TOP_N_NEIGHBORS = 20;
const CO_RATED_CAP = 50;

// Minimum-support gate for Top-5 CANDIDATES ONLY (not for a single Predict
// Rating lookup, which reports whatever support it has instead -- see
// predictRating()). A candidate must have at least MIN_ITEM_RATINGS ratings
// total in the dataset (its own baseline mean has to be based on more than
// one or two people) AND at least MIN_NEIGHBOURS neighbors must actually
// contribute to its predicted score (the aggregate() correction term
// shouldn't rest on a single neighbor's raw deviation). See analysis.js for
// the before/after measurement this was tuned against.
const MIN_ITEM_RATINGS = 5;
const MIN_NEIGHBOURS = 3;

// Item-item similarity is independent of which user is active, so it is
// precomputed once after data loads and reused for every Top-5 / Predict
// Rating request for the rest of the session, instead of being recomputed
// per click (see the cost estimate in buildItemSimilarityCache below).
let itemSimilarityCache = null; // Float32Array, symmetric, index = a*(numMovies+1)+b

// Initialize the application when the window loads
window.onload = async function() {
    const userBased = document.getElementById('user-based-result');
    const itemBased = document.getElementById('item-based-result');
    const predictResult = document.getElementById('predict-result');
    const recommendBtn = document.getElementById('recommend-btn');
    const predictBtn = document.getElementById('predict-btn');

    recommendBtn.disabled = true;
    predictBtn.disabled = true;

    try {
        userBased.innerHTML = '<p>Loading movie data...</p>';
        itemBased.innerHTML = '<p>Loading movie data...</p>';
        predictResult.innerHTML = '<p>Loading movie data...</p>';

        await loadData();

        userBased.innerHTML = '<p>Preparing recommendations...</p>';
        itemBased.innerHTML = '<p>Preparing recommendations...</p>';
        predictResult.innerHTML = '<p>Preparing recommendations...</p>';

        // Let the "Preparing..." message paint before the (one-time,
        // ~1s) item-item similarity precompute blocks the main thread.
        // requestAnimationFrame alone is NOT enough: its callback runs
        // BEFORE the browser paints that frame, so synchronous work done
        // inside it still delays the paint. setTimeout(0), queued from
        // inside the rAF callback, runs after that frame has actually been
        // rendered -- this is the standard "yield past a paint" pattern.
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        buildItemSimilarityCache();

        populateUserDropdown();
        populateMovieDropdown();

        userBased.innerHTML = '<p>Data loaded. Select a user.</p>';
        itemBased.innerHTML = '<p>Data loaded. Select a user.</p>';
        predictResult.innerHTML = '<p>Data loaded. Select a user and a movie.</p>';

        recommendBtn.disabled = false;
        predictBtn.disabled = false;
    } catch (error) {
        console.error('Initialization error:', error);
        // The error message is already shown by data.js
    }
};

// Populate the user dropdown with one option per user id found in u.data
function populateUserDropdown() {
    const selectElement = document.getElementById('user-select');

    // Clear existing options except the first placeholder
    while (selectElement.options.length > 1) {
        selectElement.remove(1);
    }

    for (let userId = 1; userId <= numUsers; userId++) {
        const option = document.createElement('option');
        option.value = userId;
        option.textContent = `User ${userId}`;
        selectElement.appendChild(option);
    }
}

// Populate the movie dropdown (for Predict Rating), sorted by title so it's
// actually browsable -- u.item's id order is arbitrary. 18 titles in u.item
// are duplicated across different ids (e.g. two distinct "Chasing Amy
// (1997)"), so those -- and only those -- get "(id N)" appended to tell the
// entries apart; everything else keeps its plain title.
function populateMovieDropdown() {
    const selectElement = document.getElementById('movie-select');

    while (selectElement.options.length > 1) {
        selectElement.remove(1);
    }

    const titleCounts = new Map();
    for (const movie of movies) {
        titleCounts.set(movie.title, (titleCounts.get(movie.title) ?? 0) + 1);
    }

    const sortedMovies = [...movies].sort((a, b) => a.title.localeCompare(b.title));
    for (const movie of sortedMovies) {
        const option = document.createElement('option');
        option.value = movie.id;
        option.textContent = titleCounts.get(movie.title) > 1
            ? `${movie.title} (id ${movie.id})`
            : movie.title;
        selectElement.appendChild(option);
    }
}

// Cosine similarity between two sparse rating vectors (Map<id, rating>),
// using only co-rated (non-zero) entries. See the module header for why the
// inputs are Maps rather than dense arrays.
function cosineSimilarity(a, b) {
    return cosineSimilaritySparse(a, b).sim;
}

// Shared by cosineSimilarity() (which only needs the ratio) and every
// caller that also needs n, the co-rated count, for the min(n,50)/50 weight.
function cosineSimilaritySparse(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0, normA = 0, normB = 0, n = 0;

    for (const [id, ratingA] of small) {
        const ratingB = large.get(id);
        if (ratingB === undefined) continue;
        n++;
        dot += ratingA * ratingB;
        normA += ratingA * ratingA;
        normB += ratingB * ratingB;
    }

    if (n === 0 || normA === 0 || normB === 0) return { sim: 0, n };
    return { sim: dot / (Math.sqrt(normA) * Math.sqrt(normB)), n };
}

// The chosen missing-value strategy: raw cosine, discounted by how much
// co-rated evidence it's actually based on.
function weightedSimilarity(a, b) {
    const { sim, n } = cosineSimilaritySparse(a, b);
    if (n === 0) return 0;
    return sim * Math.min(n, CO_RATED_CAP) / CO_RATED_CAP;
}

// The active user's fixed neighbor set: every other user with positive
// weighted similarity, ranked, top 20. Computed once per request and reused
// across every candidate movie (Top-5) or passed straight to a single
// Predict Rating call -- this is the O(numUsers) part of user-based CF and
// is cheap enough (~943 sparse comparisons) to redo per click.
function getTopUserNeighbors(activeUserId, topN = TOP_N_NEIGHBORS) {
    const activeRatings = userRatings.get(activeUserId);
    if (!activeRatings) return [];

    const candidates = [];
    for (const [otherUserId, otherRatings] of userRatings) {
        if (otherUserId === activeUserId) continue;
        const weight = weightedSimilarity(activeRatings, otherRatings);
        if (weight > 0) candidates.push({ userId: otherUserId, weight });
    }

    candidates.sort((a, b) => b.weight - a.weight);
    return candidates.slice(0, topN);
}

// Pure aggregation step of the mean-centered formula:
//   predicted = baseline + sum(sim * (rating - mean)) / sum(|sim|)
// neighbors: [{ sim, rating, mean }, ...]. Normalizing by sum(|sim|) rather
// than sum(sim) means a negative-similarity neighbor correctly pulls the
// prediction away from their rating rather than toward it. Not clamped --
// callers clamp to [1, 5] (see module header for why that's needed) after
// deciding what to do with the raw value. Returns null if `neighbors` is
// empty or every sim is 0 (nothing to divide by).
//
// Exposed standalone (not inlined into predictUserBased/predictItemBased)
// so analysis.js can test it directly against the lecture's worked example,
// which hands you precomputed {sim, rating, mean} triples, not a rating
// matrix to derive them from.
function aggregate(baseline, neighbors) {
    let numerator = 0, denom = 0;
    for (const { sim, rating, mean } of neighbors) {
        numerator += sim * (rating - mean);
        denom += Math.abs(sim);
    }
    if (denom === 0) return null;
    return baseline + numerator / denom;
}

// baseline = active user's own mean rating. Returns null if none of the
// active user's neighbors rated this movie (nothing to predict from),
// otherwise { score, k } where k is how many neighbors actually
// contributed -- see MIN_NEIGHBOURS above and predictRating() below, which
// both use k to decide whether/how to surface a prediction.
function predictUserBased(activeUserId, movieId, neighbors) {
    const baseline = userMean.get(activeUserId);
    if (baseline === undefined) return null;

    const contributing = [];
    for (const { userId, weight } of neighbors) {
        const rating = userRatings.get(userId).get(movieId);
        if (rating === undefined) continue;
        contributing.push({ sim: weight, rating, mean: userMean.get(userId) });
    }
    if (contributing.length === 0) return null;

    const predicted = aggregate(baseline, contributing);
    return { score: Math.min(5, Math.max(1, predicted)), k: contributing.length }; // clamp -- see module header
}

// Deterministic tie-break for Top-K sorting: score desc, then k (contributing
// neighbors) desc, then total rating count desc, then title asc. Clamping
// to [1, 5] means many distinct candidates legitimately predict to exactly
// 5.000 (measured: 248/943 users had an all-5.000 user-based Top-5, 82/943
// item-based; 235/943 and 66/943 had a score tie between 5th and 6th place
// -- see analysis.js). Without this, Array.sort's tie-break is "whichever
// stable-sorted first", which for these candidates is just u.item's file
// order -- an artifact of the dataset file, not a measure of confidence.
function compareCandidates(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.k !== a.k) return b.k - a.k;
    if (b.totalRatings !== a.totalRatings) return b.totalRatings - a.totalRatings;
    return a.title.localeCompare(b.title);
}

function getUserBasedRecommendations(activeUserId, topK = 5) {
    const activeRatings = userRatings.get(activeUserId);
    if (!activeRatings) return [];

    const neighbors = getTopUserNeighbors(activeUserId);
    if (neighbors.length === 0) return [];

    const results = [];
    for (const movie of movies) {
        if (activeRatings.has(movie.id)) continue;
        const totalRatings = itemRatings.get(movie.id)?.size ?? 0;
        if (totalRatings < MIN_ITEM_RATINGS) continue;
        const result = predictUserBased(activeUserId, movie.id, neighbors);
        if (result === null || result.k < MIN_NEIGHBOURS) continue;
        results.push({ title: movie.title, score: result.score, k: result.k, totalRatings });
    }

    results.sort(compareCandidates);
    return results.slice(0, topK).map(({ title, score, k }) => ({ title, score, k }));
}

// ---------------------------------------------------------------------------
// Item-item similarity is the same weighted cosine as the user-based side,
// just over itemRatings columns instead of userRatings rows, and it does
// not depend on any particular active user. Computing it on demand inside
// getItemBasedRecommendations (as the readme's step 1 describes -- for each
// of the user's ~106 rated movies, compare against all 1682 other movies)
// costs roughly ratedByUser x numMovies x numUsers scalar ops per click:
// ~106 x 1682 x 944 =~ 168M for an average user, several times that for a
// heavy rater -- enough to visibly freeze the tab on every "Get
// Recommendations" click. Precomputing it once, here, after load costs
// roughly numMovies^2 / 2 sparse comparisons (~1.4M pairs, bounded by each
// movie's actual rater count rather than numUsers) and is then a Float32Array
// lookup per (item, item) pair for the rest of the session.
// ---------------------------------------------------------------------------
function buildItemSimilarityCache() {
    const stride = numMovies + 1;
    itemSimilarityCache = new Float32Array(stride * stride); // 0 = "no/no positive similarity"

    const itemIds = [...itemRatings.keys()];
    for (let a = 0; a < itemIds.length; a++) {
        const idA = itemIds[a];
        const ratingsA = itemRatings.get(idA);
        for (let b = a + 1; b < itemIds.length; b++) {
            const idB = itemIds[b];
            const ratingsB = itemRatings.get(idB);
            const weight = weightedSimilarity(ratingsA, ratingsB);
            if (weight <= 0) continue;
            itemSimilarityCache[idA * stride + idB] = weight;
            itemSimilarityCache[idB * stride + idA] = weight;
        }
    }
}

function itemSimilarity(idA, idB) {
    return itemSimilarityCache[idA * (numMovies + 1) + idB];
}

// baseline = the target movie's own mean rating. ratedByUser is the active
// user's own Map<movieId, rating>. Returns null if none of the user's rated
// movies has positive cached similarity to this movie, otherwise
// { score, k } -- see predictUserBased above.
function predictItemBased(movieId, ratedByUser) {
    const baseline = itemMean.get(movieId);
    if (baseline === undefined) return null;

    const candidates = [];
    for (const [ratedMovieId, userRating] of ratedByUser) {
        if (ratedMovieId === movieId) continue;
        const weight = itemSimilarity(movieId, ratedMovieId);
        if (weight > 0) candidates.push({ sim: weight, rating: userRating, mean: itemMean.get(ratedMovieId) });
    }
    candidates.sort((a, b) => b.sim - a.sim);
    const contributing = candidates.slice(0, TOP_N_NEIGHBORS);
    if (contributing.length === 0) return null;

    const predicted = aggregate(baseline, contributing);
    return { score: Math.min(5, Math.max(1, predicted)), k: contributing.length }; // clamp -- see module header
}

function getItemBasedRecommendations(activeUserId, topK = 5) {
    const activeRatings = userRatings.get(activeUserId);
    if (!activeRatings) return [];

    const results = [];
    for (const movie of movies) {
        if (activeRatings.has(movie.id)) continue;
        const totalRatings = itemRatings.get(movie.id)?.size ?? 0;
        if (totalRatings < MIN_ITEM_RATINGS) continue;
        const result = predictItemBased(movie.id, activeRatings);
        if (result === null || result.k < MIN_NEIGHBOURS) continue;
        results.push({ title: movie.title, score: result.score, k: result.k, totalRatings });
    }

    results.sort(compareCandidates);
    return results.slice(0, topK).map(({ title, score, k }) => ({ title, score, k }));
}

// Disables `button` and swaps its label to `busyText` for the duration of
// `fn`. A click that arrives while `button` is already disabled is a no-op
// (the double-click guard), and the busy label actually paints before the
// (synchronous) work runs -- see the two comments below for why each half
// needs the rAF+setTimeout pairing, not just one or the other.
function withBusyUI(button, busyText, fn) {
    if (button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;

    // requestAnimationFrame's callback runs BEFORE the browser paints that
    // frame -- calling fn() directly inside it would still block the paint
    // that's supposed to show `busyText`. setTimeout(0), queued from inside
    // the rAF callback, runs after that frame has been rendered.
    requestAnimationFrame(() => {
        setTimeout(() => {
            try {
                fn();
            } finally {
                // Also delayed, for a different reason: clicks that arrive
                // while fn() blocks the main thread are queued by the
                // browser and only dispatched once this task finishes.
                // Re-enabling the button synchronously right here would let
                // the FIRST such queued click see `disabled === false` and
                // re-enter fn() -- defeating the guard above. Deferring the
                // re-enable by one more macrotask lets any already-queued
                // clicks run first (and get rejected by that guard) before
                // the button becomes clickable again.
                setTimeout(() => {
                    button.disabled = false;
                    button.textContent = originalText;
                }, 0);
            }
        }, 0);
    });
}

// Modified from the original scaffold -- see readme.md section 5.6, which
// asks for the "Because you are similar to..." / "Because you liked..."
// framing and "a clear message" on the empty case. The scaffold's version of
// this function (labelled "Provided") did neither: it rendered a bare
// title/score list with no framing, and its empty-case text
// ("Implement the TODO above") was a placeholder for the unfinished stubs,
// not a real user-facing message. It has to change for either requirement
// to be met.
function getRecommendations() {
    const selectElement = document.getElementById('user-select');
    const userId = parseInt(selectElement.value, 10);
    const button = document.getElementById('recommend-btn');

    if (isNaN(userId)) {
        renderList('user-based-result', [], 'Please select a user first.');
        renderList('item-based-result', [], 'Please select a user first.');
        return;
    }

    withBusyUI(button, 'Computing...', () => {
        renderList(
            'user-based-result',
            getUserBasedRecommendations(userId),
            null,
            'Because you are similar to other users, we recommend:'
        );
        renderList(
            'item-based-result',
            getItemBasedRecommendations(userId),
            null,
            'Because you liked movies like these, we recommend:'
        );
    });
}

// New -- the readme's own spec never asked for this (see the UI conflict
// noted in the review), but the lecture mockup requires it: pick a user AND
// a movie, get both CF approaches' predicted rating for that one pair,
// side by side. Unlike Top-5, this does NOT apply MIN_ITEM_RATINGS /
// MIN_NEIGHBOURS -- it's a single informational lookup, not a ranked list,
// so instead of hiding low-support predictions it shows them with their
// support count attached ("(k neighbours)"), and only refuses to show a
// number at all when k = 0 (nothing whatsoever to base it on).
function predictRating() {
    const userId = parseInt(document.getElementById('user-select').value, 10);
    const movieId = parseInt(document.getElementById('movie-select').value, 10);
    const button = document.getElementById('predict-btn');

    if (isNaN(userId) || isNaN(movieId)) {
        renderPrediction('Please select both a user and a movie.');
        return;
    }

    withBusyUI(button, 'Computing...', () => {
        const activeRatings = userRatings.get(userId);
        if (!activeRatings) {
            renderPrediction('Not enough data for this user.');
            return;
        }

        const neighbors = getTopUserNeighbors(userId);
        const userResult = predictUserBased(userId, movieId, neighbors);
        const itemResult = predictItemBased(movieId, activeRatings);

        if (userResult === null && itemResult === null) {
            renderPrediction('Not enough data to predict a rating for this movie.');
            return;
        }

        // Shown alongside the predictions as a sanity check when the user
        // already rated this movie -- the predictions themselves are
        // unaffected (still computed the normal way, nothing excluded).
        const actualRating = activeRatings.get(movieId);
        renderPrediction(null, userResult, itemResult, actualRating);
    });
}

// Renders either a status `message`, or the two side-by-side predictions.
// userResult/itemResult are { score, k } or null (no contributing neighbors
// at all -- shown as "Not enough data" rather than a number). actualRating
// is the active user's own rating for this movie, if they already rated it.
function renderPrediction(message, userResult = null, itemResult = null, actualRating = undefined) {
    const el = document.getElementById('predict-result');

    if (message) {
        el.innerHTML = `<p>${message}</p>`;
        return;
    }

    const format = (result) => result === null
        ? 'Not enough data'
        : `${result.score.toFixed(1)} predicted (${result.k} neighbour${result.k === 1 ? '' : 's'})`;

    const actualLine = actualRating === undefined ? '' : `<p>Actual rating: <strong>${actualRating}</strong></p>`;

    el.innerHTML = `
        <p>User-Based CF: <strong>${format(userResult)}</strong></p>
        <p>Item-Based CF: <strong>${format(itemResult)}</strong></p>
        ${actualLine}
    `;
}

// Modified from the original scaffold -- adds the reasonText framing and a
// real empty-case message; see the comment above getRecommendations().
function renderList(elementId, items, message, reasonText) {
    const el = document.getElementById(elementId);

    if (message) {
        el.innerHTML = `<p>${message}</p>`;
        return;
    }

    if (!items || items.length === 0) {
        el.innerHTML = '<p>Not enough ratings for this user to build a recommendation yet.</p>';
        return;
    }

    const entries = items
        .map(item => `<li>${item.title} &mdash; ${Number(item.score).toFixed(3)} (${item.k} neighbour${item.k === 1 ? '' : 's'})</li>`)
        .join('');
    const reason = reasonText ? `<p>${reasonText}</p>` : '';
    el.innerHTML = `${reason}<ul>${entries}</ul>`;
}
