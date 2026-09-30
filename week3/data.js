// Global variables for storing movie and rating data
let movies = [];
let ratings = [];

// Collaborative filtering structures (populated by buildRatingMatrix)
let numUsers = 0;          // highest user id found in u.data
let numMovies = 0;         // highest movie id found in u.item (see buildRatingMatrix)
let ratingMatrix = null;   // (numUsers + 1) x (numMovies + 1); 0 = "not rated"

// Sparse rating structures (co-rated-only similarity needs these, not the
// dense matrix -- see the perf note in script.js). Built by buildRatingMatrix().
let userRatings = null;    // Map<userId, Map<movieId, rating>>
let itemRatings = null;    // Map<movieId, Map<userId, rating>>
let userMean = null;       // Map<userId, average rating>
let itemMean = null;       // Map<movieId, average rating>

// Genre names as defined in the u.item file
const genreNames = [
    "Action", "Adventure", "Animation", "Children's", "Comedy",
    "Crime", "Documentary", "Drama", "Fantasy", "Film-Noir",
    "Horror", "Musical", "Mystery", "Romance", "Sci-Fi",
    "Thriller", "War", "Western"
];

// u.item's 24 pipe-delimited fields are:
//   0 id | 1 title | 2 release date | 3 video release date | 4 IMDb URL |
//   5 "unknown" genre flag | 6..23 the 18 named genre flags (Action..Western)
// The "unknown" flag at field 5 is not one of the 18 named genres above --
// slicing from field 5 instead of field 6 shifts every genre label by one
// column (e.g. Toy Story would come out as Children's/Comedy/Crime instead
// of Animation/Children's/Comedy, and "Western" would never match at all).
const GENRE_FLAGS_START = 6;

// Primary function to load data from files
async function loadData() {
    try {
        // u.item is Latin-1 (ISO-8859-1) encoded -- e.g. movie id 543 is
        // "Mis\xe9rables, Les (1995)" -- so it must be decoded explicitly.
        // response.text() defaults to UTF-8 and would turn that byte (and
        // the other 8 accented titles in this file) into a replacement
        // character (`�`).
        const moviesResponse = await fetch('u.item');
        if (!moviesResponse.ok) {
            throw new Error(`Failed to load movie data: ${moviesResponse.status}`);
        }
        const moviesBuffer = await moviesResponse.arrayBuffer();
        const moviesText = new TextDecoder('iso-8859-1').decode(moviesBuffer);
        parseItemData(moviesText);

        // u.data is plain ASCII (ids, tabs, a rating digit, a timestamp),
        // so the default UTF-8 text decoding is fine here.
        const ratingsResponse = await fetch('u.data');
        if (!ratingsResponse.ok) {
            throw new Error(`Failed to load rating data: ${ratingsResponse.status}`);
        }
        const ratingsText = await ratingsResponse.text();
        parseRatingData(ratingsText);

        // Derive matrix dimensions, then build the rating structures.
        numUsers = ratings.reduce((max, r) => Math.max(max, r.userId), 0);
        // Use the highest movie id actually present, not movies.length --
        // parseItemData() skips malformed lines, so the two can diverge and
        // a later id would then fall outside a matrix sized by .length.
        numMovies = movies.reduce((max, m) => Math.max(max, m.id), 0);
        buildRatingMatrix();
    } catch (error) {
        console.error('Error loading data:', error);
        // Both result panes are stuck on "Loading..." until this runs, so
        // both need the error, not just the user-based one.
        const message = `<p class="error">Error: ${error.message}. Please make sure u.item and u.data are in the correct location.</p>`;
        for (const id of ['user-based-result', 'item-based-result', 'predict-result']) {
            const target = document.getElementById(id);
            if (target) target.innerHTML = message;
        }
        throw error; // Re-throw so script.js can handle the error
    }
}

// Parse movie data from u.item format
function parseItemData(text) {
    const lines = text.split('\n');

    for (const line of lines) {
        if (line.trim() === '') continue;

        const fields = line.split('|');
        if (fields.length < GENRE_FLAGS_START + genreNames.length) continue; // Skip invalid lines

        const id = parseInt(fields[0]);
        const title = fields[1];

        // Extract the 18 named genre flags, skipping the "unknown" flag at
        // field 5 (see GENRE_FLAGS_START above).
        const genreValues = fields
            .slice(GENRE_FLAGS_START, GENRE_FLAGS_START + genreNames.length)
            .map(value => parseInt(value));
        const genres = genreNames.filter((_, index) => genreValues[index] === 1);

        movies.push({ id, title, genres });
    }
}

// Parse rating data from u.data format
function parseRatingData(text) {
    const lines = text.split('\n');

    for (const line of lines) {
        if (line.trim() === '') continue;

        const fields = line.split('\t');
        if (fields.length < 4) continue; // Skip invalid lines

        const userId = parseInt(fields[0]);
        const itemId = parseInt(fields[1]);
        const rating = parseFloat(fields[2]);
        const timestamp = parseInt(fields[3]);

        ratings.push({ userId, itemId, rating, timestamp });
    }
}

// ---------------------------------------------------------------------------
// Build the user-item rating matrix and the sparse structures the
// recommendation code actually runs on.
//
// Dense matrix: shape (numUsers + 1) x (numMovies + 1), indexed by raw id,
// so that ratingMatrix[userId][movieId] === rating and a missing entry is 0.
// MovieLens ratings are always integers 1-5 (verified against u.data), so 0
// is an unambiguous "not rated" sentinel and no separate boolean mask is
// needed on top of it.
//
// Sparse maps: userRatings / itemRatings mirror the same data as
// Map<id, Map<id, rating>>, plus the per-user / per-item rating means. The
// recommendation functions use these, not the dense matrix -- walking a
// full 1683- or 944-length row/column per comparison (as the dense matrix
// would require) is the difference between a sub-second Top-5 request and
// one that visibly freezes the tab. See script.js for how they're used.
// ---------------------------------------------------------------------------
function buildRatingMatrix() {
    ratingMatrix = Array.from({ length: numUsers + 1 }, () => new Array(numMovies + 1).fill(0));
    userRatings = new Map();
    itemRatings = new Map();

    for (const { userId, itemId, rating } of ratings) {
        ratingMatrix[userId][itemId] = rating;

        if (!userRatings.has(userId)) userRatings.set(userId, new Map());
        userRatings.get(userId).set(itemId, rating);

        if (!itemRatings.has(itemId)) itemRatings.set(itemId, new Map());
        itemRatings.get(itemId).set(userId, rating);
    }

    userMean = new Map();
    for (const [userId, ratingsForUser] of userRatings) {
        let sum = 0;
        for (const r of ratingsForUser.values()) sum += r;
        userMean.set(userId, sum / ratingsForUser.size);
    }

    itemMean = new Map();
    for (const [itemId, ratingsForItem] of itemRatings) {
        let sum = 0;
        for (const r of ratingsForItem.values()) sum += r;
        itemMean.set(itemId, sum / ratingsForItem.size);
    }
}
