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
    const counts = movies
        .map(m => (movieStats.get(m.id) || { count: 0 }).count)
        .sort((a, b) => a - b);
    const mid = Math.floor(counts.length / 2);
    const median = counts.length % 2 === 0 ? (counts[mid - 1] + counts[mid]) / 2 : counts[mid];
    console.log(`  catalog median rating count: ${median}`);

    function longTailShare(top5, label) {
        const below = top5.filter(m => m.stats.count < median).length;
        console.log(`  ${label}: ${below} / ${top5.length} items below median (${((below / top5.length) * 100).toFixed(0)}%)`);
    }
    longTailShare(item2itemTop5, 'item-to-item Top-5');
    longTailShare(profileTop5, 'profile Top-5');
}

main();
