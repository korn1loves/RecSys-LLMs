#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HW3 analysis script -- run with `node analysis.js` from week3/.
//
// This does NOT reimplement the recommender: it loads data.js and script.js
// verbatim (same source, same functions the browser runs) into a Node vm
// context and drives them, so the figures below can never silently drift
// from what the app actually computes.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;

function loadAppSource() {
    const dataSrc = fs.readFileSync(path.join(DIR, 'data.js'), 'utf8');
    const scriptSrc = fs.readFileSync(path.join(DIR, 'script.js'), 'utf8');
    return dataSrc + '\n' + scriptSrc;
}

function readDataset() {
    // 'latin1' is Node's built-in name for ISO-8859-1 -- same decoding
    // data.js does in the browser via TextDecoder('iso-8859-1').
    const itemText = fs.readFileSync(path.join(DIR, 'u.item')).toString('latin1');
    const dataText = fs.readFileSync(path.join(DIR, 'u.data'), 'utf8');
    return { itemText, dataText };
}

function main() {
    const { itemText, dataText } = readDataset();
    const appSource = loadAppSource();

    // Everything below runs inside the SAME vm context as data.js/script.js,
    // so it can reference their globals/functions (movies, userRatings,
    // aggregate, predictUserBased, MIN_ITEM_RATINGS, ...) directly as plain
    // identifiers, rather than trying to marshal them out through the
    // context object (vm contexts don't expose top-level let/const as
    // properties of the context -- only running more code in the same
    // context can see them).
    const driver = `
        parseItemData(__itemText);
        parseRatingData(__dataText);
        numUsers = ratings.reduce((max, r) => Math.max(max, r.userId), 0);
        numMovies = movies.reduce((max, m) => Math.max(max, m.id), 0);
        buildRatingMatrix();
        const __cacheT0 = Date.now();
        buildItemSimilarityCache(); // needed by predictItemBased below -- built once, up front, like the browser does after load
        const __cacheMs = Date.now() - __cacheT0;

        console.log(\`Loaded \${movies.length} movies, \${ratings.length} ratings, \${numUsers} users, \${numMovies} max movie id.\\n\`);

        // --- sparsity / cold-start -------------------------------------
        console.log('=== Sparsity / cold-start ===');
        const density = ratings.length / (numUsers * numMovies);
        console.log(\`density: \${(density * 100).toFixed(2)}% (\${ratings.length} / \${numUsers}x\${numMovies})\`);

        let sparseItems = 0;
        for (const counts of itemRatings.values()) if (counts.size < 5) sparseItems++;
        console.log(\`movies with < 5 ratings: \${sparseItems} / \${itemRatings.size}\`);

        const userCounts = [...userRatings.values()].map(m => m.size).sort((a, b) => a - b);
        console.log(\`ratings per user: min \${userCounts[0]}, median \${userCounts[Math.floor(userCounts.length / 2)]}, max \${userCounts[userCounts.length - 1]}\`);
        console.log('');

        // --- raw cosine vs co-rated count, + weighted-sim/n correlation --
        console.log('=== Raw cosine vs. co-rated count; weighted-similarity vs. n correlation (user pairs) ===');
        console.log('(shows the weighting is MITIGATION, not a fix: raw cosine barely moves with n, so');
        console.log(' weighted similarity ends up almost entirely a function of n, not of actual rating agreement)');
        const users = [...userRatings.keys()].sort((a, b) => a - b);
        const buckets = new Map();
        // running sums for Pearson r between n and weightedSim
        let cnt = 0, sumN = 0, sumW = 0, sumNW = 0, sumN2 = 0, sumW2 = 0;
        for (let i = 0; i < users.length; i++) {
            const a = userRatings.get(users[i]);
            for (let j = i + 1; j < users.length; j++) {
                const b = userRatings.get(users[j]);
                const { sim, n } = cosineSimilaritySparse(a, b);
                if (n === 0) continue;
                if (!buckets.has(n)) buckets.set(n, { count: 0, sum: 0 });
                const bk = buckets.get(n);
                bk.count++;
                bk.sum += sim;

                const w = sim * Math.min(n, CO_RATED_CAP) / CO_RATED_CAP;
                cnt++; sumN += n; sumW += w; sumNW += n * w; sumN2 += n * n; sumW2 += w * w;
            }
        }
        function aggregateBuckets(pred) {
            let count = 0, sum = 0;
            for (const [n, bk] of buckets) { if (!pred(n)) continue; count += bk.count; sum += bk.sum; }
            return count ? (sum / count) : NaN;
        }
        console.log(\`avg raw cosine at n=1: \${aggregateBuckets(n => n === 1).toFixed(4)}\`);
        console.log(\`avg raw cosine at n<5: \${aggregateBuckets(n => n < 5).toFixed(4)}\`);
        console.log(\`avg raw cosine at 5<=n<20: \${aggregateBuckets(n => n >= 5 && n < 20).toFixed(4)}\`);
        console.log(\`avg raw cosine at n>=50: \${aggregateBuckets(n => n >= 50).toFixed(4)}\`);

        const pearsonR = (cnt * sumNW - sumN * sumW) / Math.sqrt((cnt * sumN2 - sumN * sumN) * (cnt * sumW2 - sumW * sumW));
        console.log(\`Pearson r(n, weighted similarity) across \${cnt} pairs: \${pearsonR.toFixed(4)}\`);
        console.log('');

        // --- toy example: aggregate() tested directly, no rating matrix --
        console.log('=== Toy example (lecture formulas), tested via aggregate() directly ===');
        console.log('The lecture hands you precomputed {sim, rating, mean} triples, not a rating');
        console.log('matrix to derive them from, so this tests aggregate() in isolation.');
        function checkToy(label, baseline, neighbors, expected) {
            const predicted = aggregate(baseline, neighbors);
            const pass = Math.abs(predicted - expected) <= 0.01;
            console.log(\`\${label}: predicted \${predicted.toFixed(4)}, expected ~\${expected} -> \${pass ? 'PASS' : 'FAIL'}\`);
        }
        checkToy('user-based (slide 9) ', 13 / 3, [
            { sim: 1.00, rating: 2, mean: 10 / 3 },
            { sim: -1.00, rating: 5, mean: 8 / 3 },
            { sim: 0.866, rating: 4, mean: 4.00 },
        ], 3.05);
        // Slide 12 itself prints the Star Wars mean as "1.33", which is
        // inconsistent with its own stated deviation/effect for that
        // neighbor; 10/3 (~3.33) is the only value that reproduces the
        // slide's own expected ~2.58, so that's what's used below.
        checkToy('item-based (slide 12)', 11 / 3, [
            { sim: -0.99, rating: 5, mean: 10 / 3 },
            { sim: 0.72, rating: 3, mean: 3.00 },
            { sim: -0.84, rating: 5, mean: 11 / 3 },
        ], 2.58);
        console.log('');

        // --- MIN_ITEM_RATINGS / MIN_NEIGHBOURS: before/after ------------
        console.log('=== Sparse-item promotion into Top-5: before vs. after MIN_ITEM_RATINGS/MIN_NEIGHBOURS ===');
        console.log(\`(current constants: MIN_ITEM_RATINGS=\${MIN_ITEM_RATINGS}, MIN_NEIGHBOURS=\${MIN_NEIGHBOURS})\`);

        // "before": same predictUserBased/predictItemBased + aggregate(),
        // just without the MIN_ITEM_RATINGS/MIN_NEIGHBOURS gate that now
        // lives in getUserBasedRecommendations/getItemBasedRecommendations
        // -- i.e. exactly what the code did before this fix.
        function unfilteredTop5User(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const neighbors = getTopUserNeighbors(userId);
            if (neighbors.length === 0) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                const result = predictUserBased(userId, movie.id, neighbors);
                if (result === null) continue;
                results.push({ id: movie.id, score: result.score });
            }
            results.sort((a, b) => b.score - a.score);
            return results.slice(0, 5);
        }
        function unfilteredTop5Item(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                const result = predictItemBased(movie.id, activeRatings);
                if (result === null) continue;
                results.push({ id: movie.id, score: result.score });
            }
            results.sort((a, b) => b.score - a.score);
            return results.slice(0, 5);
        }
        // "after": same predict calls + same MIN_ITEM_RATINGS/MIN_NEIGHBOURS
        // gate as the real getUserBasedRecommendations/getItemBasedRecommendations
        // (not called directly because 18 titles in u.item are duplicated
        // across different ids -- e.g. two different "Chasing Amy (1997)" --
        // so title can't be mapped back to id reliably; the gate condition
        // and predict functions are identical either way).
        function filteredTop5User(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const neighbors = getTopUserNeighbors(userId);
            if (neighbors.length === 0) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                if ((itemRatings.get(movie.id)?.size ?? 0) < MIN_ITEM_RATINGS) continue;
                const result = predictUserBased(userId, movie.id, neighbors);
                if (result === null || result.k < MIN_NEIGHBOURS) continue;
                results.push({ id: movie.id, score: result.score });
            }
            results.sort((a, b) => b.score - a.score);
            return results.slice(0, 5);
        }
        function filteredTop5Item(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                if ((itemRatings.get(movie.id)?.size ?? 0) < MIN_ITEM_RATINGS) continue;
                const result = predictItemBased(movie.id, activeRatings);
                if (result === null || result.k < MIN_NEIGHBOURS) continue;
                results.push({ id: movie.id, score: result.score });
            }
            results.sort((a, b) => b.score - a.score);
            return results.slice(0, 5);
        }

        function measure(top5Fn) {
            let totalItems = 0, sparseItems = 0, emptyLists = 0;
            for (const userId of users) {
                const top5 = top5Fn(userId);
                if (top5.length === 0) emptyLists++;
                for (const { id } of top5) {
                    totalItems++;
                    if ((itemRatings.get(id)?.size ?? 0) < 5) sparseItems++;
                }
            }
            return { totalItems, sparseItems, emptyLists, share: totalItems ? sparseItems / totalItems : NaN };
        }

        const beforeUser = measure(unfilteredTop5User);
        const beforeItem = measure(unfilteredTop5Item);
        const afterUser = measure(filteredTop5User);
        const afterItem = measure(filteredTop5Item);

        console.log(\`user-based BEFORE: \${beforeUser.sparseItems}/\${beforeUser.totalItems} Top-5 slots (\${(beforeUser.share * 100).toFixed(1)}%) are movies with <5 total ratings, across \${users.length} users\`);
        console.log(\`user-based AFTER:  \${afterUser.sparseItems}/\${afterUser.totalItems} Top-5 slots (\${(afterUser.share * 100).toFixed(1)}%), \${afterUser.emptyLists} users left with an empty list\`);
        console.log(\`item-based BEFORE: \${beforeItem.sparseItems}/\${beforeItem.totalItems} Top-5 slots (\${(beforeItem.share * 100).toFixed(1)}%) are movies with <5 total ratings, across \${users.length} users\`);
        console.log(\`item-based AFTER:  \${afterItem.sparseItems}/\${afterItem.totalItems} Top-5 slots (\${(afterItem.share * 100).toFixed(1)}%), \${afterItem.emptyLists} users left with an empty list\`);
        console.log('');

        // --- deterministic tie-break: before/after -----------------------
        console.log('=== Top-5 score ties, before vs. after the deterministic tie-break ===');
        console.log('(the tie counts themselves cannot change: a tie-break decides WHICH tied');
        console.log(' candidates fill the 5 slots, not how many candidates tie. What it does change');
        console.log(' is whether that choice is deterministic (score, k, total ratings, title) or');
        console.log(' just u.item file order -- measured below as how many users\\' actual Top-5 SET differs.)');

        // Full filtered candidate list (post MIN_ITEM_RATINGS/MIN_NEIGHBOURS,
        // same as the shipped get*Recommendations), unsliced, with the
        // fields compareCandidates() needs -- so both the old (score-only)
        // and new (full tie-break) orderings can be derived from the same
        // underlying set.
        function filteredCandidatesUser(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const neighbors = getTopUserNeighbors(userId);
            if (neighbors.length === 0) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                const totalRatings = itemRatings.get(movie.id)?.size ?? 0;
                if (totalRatings < MIN_ITEM_RATINGS) continue;
                const result = predictUserBased(userId, movie.id, neighbors);
                if (result === null || result.k < MIN_NEIGHBOURS) continue;
                results.push({ id: movie.id, title: movie.title, score: result.score, k: result.k, totalRatings });
            }
            return results;
        }
        function filteredCandidatesItem(userId) {
            const activeRatings = userRatings.get(userId);
            if (!activeRatings) return [];
            const results = [];
            for (const movie of movies) {
                if (activeRatings.has(movie.id)) continue;
                const totalRatings = itemRatings.get(movie.id)?.size ?? 0;
                if (totalRatings < MIN_ITEM_RATINGS) continue;
                const result = predictItemBased(movie.id, activeRatings);
                if (result === null || result.k < MIN_NEIGHBOURS) continue;
                results.push({ id: movie.id, title: movie.title, score: result.score, k: result.k, totalRatings });
            }
            return results;
        }

        const oldComparator = (a, b) => b.score - a.score; // what shipped before this fix (stable sort -> ties fall back to u.item order)
        // newComparator === compareCandidates from script.js, reused directly.

        function tieMetrics(candidatesFn, comparator) {
            let allFiveAt5 = 0, tie56 = 0;
            const top5PerUser = new Map();
            for (const userId of users) {
                const candidates = candidatesFn(userId);
                if (candidates.length === 0) continue;
                const sorted = [...candidates].sort(comparator);
                const top5 = sorted.slice(0, 5);
                if (top5.length === 5 && top5.every(c => c.score === 5)) allFiveAt5++;
                if (sorted.length >= 6 && sorted[4].score === sorted[5].score) tie56++;
                top5PerUser.set(userId, new Set(top5.map(c => c.id)));
            }
            return { allFiveAt5, tie56, top5PerUser };
        }

        function countSetChanges(beforeMap, afterMap) {
            let changed = 0;
            for (const userId of users) {
                const a = beforeMap.get(userId), b = afterMap.get(userId);
                if (!a || !b) continue;
                if (a.size !== b.size || [...a].some(id => !b.has(id))) changed++;
            }
            return changed;
        }

        const userBeforeTies = tieMetrics(filteredCandidatesUser, oldComparator);
        const userAfterTies = tieMetrics(filteredCandidatesUser, compareCandidates);
        const itemBeforeTies = tieMetrics(filteredCandidatesItem, oldComparator);
        const itemAfterTies = tieMetrics(filteredCandidatesItem, compareCandidates);

        console.log(\`user-based BEFORE: all-five=5.000 in \${userBeforeTies.allFiveAt5}/\${users.length} users, 5th/6th score tie in \${userBeforeTies.tie56}/\${users.length}\`);
        console.log(\`user-based AFTER:  all-five=5.000 in \${userAfterTies.allFiveAt5}/\${users.length} users, 5th/6th score tie in \${userAfterTies.tie56}/\${users.length}\`);
        console.log(\`user-based: Top-5 SET changed for \${countSetChanges(userBeforeTies.top5PerUser, userAfterTies.top5PerUser)}/\${users.length} users once ties are broken deterministically instead of by file order\`);
        console.log(\`item-based BEFORE: all-five=5.000 in \${itemBeforeTies.allFiveAt5}/\${users.length} users, 5th/6th score tie in \${itemBeforeTies.tie56}/\${users.length}\`);
        console.log(\`item-based AFTER:  all-five=5.000 in \${itemAfterTies.allFiveAt5}/\${users.length} users, 5th/6th score tie in \${itemAfterTies.tie56}/\${users.length}\`);
        console.log(\`item-based: Top-5 SET changed for \${countSetChanges(itemBeforeTies.top5PerUser, itemAfterTies.top5PerUser)}/\${users.length} users once ties are broken deterministically instead of by file order\`);
        console.log('');

        // --- runtime + Top-5 overlap on real data -------------------------
        console.log('=== Runtime + Top-5 overlap (real data, post-fix) ===');
        console.log(\`buildItemSimilarityCache() [one-time, after load]: \${__cacheMs.toFixed(1)}ms\`);
        console.log('');

        const sampleUsers = [1, 5, 10, 100, 500].filter(id => userRatings.has(id));
        for (const userId of sampleUsers) {
            const tu0 = Date.now();
            const userTop5 = getUserBasedRecommendations(userId);
            const tu1 = Date.now();
            const itemTop5 = getItemBasedRecommendations(userId);
            const tu2 = Date.now();

            const userTitles = new Set(userTop5.map(r => r.title));
            const itemTitles = new Set(itemTop5.map(r => r.title));
            const overlap = [...userTitles].filter(t => itemTitles.has(t)).length;

            console.log(\`user \${userId} (\${userRatings.get(userId).size} ratings): user-based \${(tu1 - tu0).toFixed(1)}ms (\${userTop5.length} results), item-based \${(tu2 - tu1).toFixed(1)}ms (\${itemTop5.length} results), Top-5 overlap \${overlap}/\${Math.min(userTop5.length, itemTop5.length)}\`);
        }
    `;

    const sandbox = {
        console,
        window: {}, // script.js assigns window.onload at top level; never invoked here
        __itemText: itemText,
        __dataText: dataText,
    };
    vm.createContext(sandbox);
    vm.runInContext(appSource + '\n' + driver, sandbox, { filename: 'week3-app+analysis' });
}

main();
