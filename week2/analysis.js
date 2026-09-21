// Offline evidence script for the A02 report. Run with `node analysis.js`
// from inside week2/. It reads u.item/u.data directly and reuses the exact
// same parsing/scoring/ranking functions from recommender.js that the app
// uses in the browser -- nothing here recomputes a formula independently.
'use strict';

const fs = require('fs');
const path = require('path');
const Recommender = require('./recommender.js');

function loadCatalog() {
    const itemText = fs.readFileSync(path.join(__dirname, 'u.item'), 'latin1');
    const dataText = fs.readFileSync(path.join(__dirname, 'u.data'), 'utf8');

    const movies = Recommender.parseItemData(itemText);
    const ratings = Recommender.parseRatingData(dataText);
    const movieStats = Recommender.computeMovieStats(ratings);

    return { movies, ratings, movieStats };
}

function findMovie(movies, id) {
    const movie = movies.find(m => m.id === id);
    if (!movie) throw new Error(`Movie id ${id} not found`);
    return movie;
}

function printTop5(label, top5) {
    console.log(label);
    top5.forEach((movie, i) => {
        console.log(
            `  ${i + 1}. [id ${movie.id}] ${movie.title} -- score=${movie.score.toFixed(4)}, ` +
            `ratingCount=${movie.stats.count}, avgRating=${movie.stats.avg.toFixed(2)}`
        );
    });
}

// --- OLD (buggy) genre parsing, reproduced ONLY to quantify defect #1's ---
// --- impact. Not used anywhere else; the app never runs this again.    ---
const OLD_GENRE_NAMES = [
    "Action", "Adventure", "Animation", "Children's", "Comedy",
    "Crime", "Documentary", "Drama", "Fantasy", "Film-Noir",
    "Horror", "Musical", "Mystery", "Romance", "Sci-Fi",
    "Thriller", "War", "Western"
];

function parseItemDataOldBuggy(text) {
    const movies = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const fields = line.split('|');
        if (fields.length < 5) continue;
        const id = parseInt(fields[0], 10);
        const genreValues = fields.slice(5, 24).map(v => parseInt(v, 10));
        const genres = OLD_GENRE_NAMES.filter((_, index) => genreValues[index] === 1);
        movies.push({ id, genres });
    }
    return movies;
}

function section(title) {
    console.log();
    console.log('='.repeat(72));
    console.log(title);
    console.log('='.repeat(72));
}

function median(numbers) {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Deterministic PRNG (mulberry32) so section 8's random profile sample is
// reproducible run-to-run without relying on Math.random.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pickDistinctIndices(rng, length, count) {
    const indices = new Set();
    while (indices.size < count) {
        indices.add(Math.floor(rng() * length));
    }
    return [...indices];
}

function main() {
    const { movies, movieStats } = loadCatalog();

    section('1. GENRE PARSE CHECK -- old slice(5,24) vs fixed slice(6,24)');
    for (const id of [1, 2, 267, 1373]) {
        const movie = findMovie(movies, id);
        console.log(`  id ${id} (${movie.title}) -> genres = [${movie.genres.join(', ')}]`);
    }

    const oldMovies = parseItemDataOldBuggy(fs.readFileSync(path.join(__dirname, 'u.item'), 'latin1'));
    const oldGenresById = new Map(oldMovies.map(m => [m.id, m.genres.join('|')]));
    let changedCount = 0;
    for (const movie of movies) {
        if ((oldGenresById.get(movie.id) || '') !== movie.genres.join('|')) changedCount += 1;
    }
    console.log(`  movies whose genre set changed after the fix: ${changedCount} / ${movies.length}`);

    section('2. COSINE SANITY CHECK -- Toy Story (id 1) vs Aladdin (id 95)');
    const toyStory = findMovie(movies, 1);
    const aladdin = findMovie(movies, 95);
    console.log(`  Toy Story genres: [${toyStory.genres.join(', ')}]`);
    console.log(`  Toy Story vector: [${toyStory.vector.join(',')}]`);
    console.log(`  Aladdin genres:   [${aladdin.genres.join(', ')}]`);
    console.log(`  Aladdin vector:   [${aladdin.vector.join(',')}]`);
    const cos = Recommender.cosineSimilarity(toyStory.vector, aladdin.vector);
    console.log(`  cosine(Toy Story, Aladdin) = ${cos}`);
    console.log('  hand check: dot=3, |ToyStory|=sqrt(3), |Aladdin|=2 -> 3/(sqrt(3)*2) = sqrt(3)/2 = ' + (Math.sqrt(3) / 2));

    section('3. ITEM-TO-ITEM vs PROFILE -- Top-5 comparison');
    const item2itemTop5 = Recommender.rankCandidates(movies, toyStory.vector, movieStats, new Set([toyStory.id]), 5);
    printTop5(`  Item-to-item Top-5 for "${toyStory.title}":`, item2itemTop5);

    const profileMovieIds = [1, 95, 71]; // Toy Story, Aladdin, Lion King
    const profileMovies = profileMovieIds.map(id => findMovie(movies, id));
    console.log(`\n  Profile built from: ${profileMovies.map(m => m.title).join(', ')}`);
    const profileVector = Recommender.buildProfileVector(profileMovies.map(m => m.vector));
    console.log(`  Profile vector: [${profileVector.map(v => v.toFixed(3)).join(',')}]`);
    const excludeIds = new Set(profileMovies.map(m => m.id));
    const profileTop5 = Recommender.rankCandidates(movies, profileVector, movieStats, excludeIds, 5);
    printTop5('  Profile Top-5:', profileTop5);

    section('4. LEAKAGE CHECK -- profile Top-5 must not contain any of the 3 selected movies');
    const leaked = profileTop5.filter(m => excludeIds.has(m.id));
    console.log(`  leaked movies: ${leaked.length === 0 ? 'none' : leaked.map(m => m.title).join(', ')}`);
    console.log(`  leakage check: ${leaked.length === 0 ? 'PASS' : 'FAIL'}`);

    section('5. POPULARITY of Top-5 items (rating count / average rating)');
    console.log('  see ratingCount / avgRating printed with each Top-5 in section 3');

    section('6. LONG-TAIL -- share of Top-5 items below the median catalog rating count');
    const catalogMedianRatingCount = median(movies.map(m => (movieStats.get(m.id) || { count: 0 }).count));
    console.log(`  catalog median rating count: ${catalogMedianRatingCount}`);

    function longTailShare(top5, label) {
        const below = top5.filter(m => m.stats.count < catalogMedianRatingCount).length;
        console.log(`  ${label}: ${below} / ${top5.length} items below median (${((below / top5.length) * 100).toFixed(0)}%)`);
    }
    longTailShare(item2itemTop5, 'item-to-item Top-5');
    longTailShare(profileTop5, 'profile Top-5');

    section('7. BIAS CHECK -- cosine vs raw dot product for "Toy Story (1995)"');
    const catalogMeanGenreCount = movies.reduce((sum, m) => sum + m.genres.length, 0) / movies.length;
    const dotTop5 = Recommender.rankCandidates(
        movies, toyStory.vector, movieStats, new Set([toyStory.id]), 5, Recommender.dotProduct
    );

    function printGenreCounts(label, top5) {
        console.log(label);
        top5.forEach((movie, i) => {
            console.log(`  ${i + 1}. [id ${movie.id}] ${movie.title} -- score=${movie.score.toFixed(4)}, genreCount=${movie.genres.length}`);
        });
        const meanGenreCount = top5.reduce((sum, m) => sum + m.genres.length, 0) / top5.length;
        console.log(`  mean genre count of this Top-5: ${meanGenreCount.toFixed(2)}`);
    }

    printGenreCounts('  Cosine Top-5 (normalized):', item2itemTop5);
    printGenreCounts('  Raw dot-product Top-5 (unnormalized):', dotTop5);
    console.log(`  catalog-wide mean genre count (all ${movies.length} movies): ${catalogMeanGenreCount.toFixed(2)}`);

    section('8. CATALOG COVERAGE -- item-to-item (all 1682 queries) vs profile mode (200 sampled profiles)');
    const itemCoverage = new Set();
    for (const queryMovie of movies) {
        const top5 = Recommender.rankCandidates(movies, queryMovie.vector, movieStats, new Set([queryMovie.id]), 5);
        for (const rec of top5) itemCoverage.add(rec.id);
    }
    const itemCoverageCounts = [...itemCoverage].map(id => (movieStats.get(id) || { count: 0 }).count);
    console.log(
        `  item-to-item: ${itemCoverage.size} / ${movies.length} distinct movies ever recommended ` +
        `(${((itemCoverage.size / movies.length) * 100).toFixed(1)}%)`
    );
    console.log(`  item-to-item recommended-set median rating count: ${median(itemCoverageCounts)}`);

    const PRNG_SEED = 42;
    const SAMPLE_SIZE = 200;
    const rng = mulberry32(PRNG_SEED);
    const profileCoverage = new Set();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
        const sampledMovies = pickDistinctIndices(rng, movies.length, 3).map(idx => movies[idx]);
        const vec = Recommender.buildProfileVector(sampledMovies.map(m => m.vector));
        const excl = new Set(sampledMovies.map(m => m.id));
        const top5 = Recommender.rankCandidates(movies, vec, movieStats, excl, 5);
        for (const rec of top5) profileCoverage.add(rec.id);
    }
    const profileCoverageCounts = [...profileCoverage].map(id => (movieStats.get(id) || { count: 0 }).count);
    console.log(
        `  profile mode (seed=${PRNG_SEED}, n=${SAMPLE_SIZE}): ${profileCoverage.size} / ${movies.length} distinct movies ever recommended ` +
        `(${((profileCoverage.size / movies.length) * 100).toFixed(1)}%)`
    );
    console.log(`  profile recommended-set median rating count: ${median(profileCoverageCounts)}`);
}

main();
