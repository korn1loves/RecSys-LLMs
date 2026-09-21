// Initialize the application when the window loads
window.onload = async function () {
    const resultElement = document.getElementById('result');
    try {
        resultElement.textContent = "Loading movie data...";
        resultElement.className = 'loading';

        await loadData();

        populateAllDropdowns();
        resultElement.textContent = "Data loaded. Please select a movie.";
        resultElement.className = 'success';
    } catch (error) {
        console.error('Initialization error:', error);
        // Error message already set in data.js
    }
};

const MOVIE_SELECT_IDS = ['movie-select', 'profile-select-1', 'profile-select-2', 'profile-select-3'];

// Populate every movie <select> (the item-to-item picker and the 3 profile
// pickers) with the same sorted option list.
function populateAllDropdowns() {
    const sortedMovies = [...movies].sort((a, b) => a.title.localeCompare(b.title));

    // A handful of titles repeat under different ids -- an artifact of
    // u.item itself (e.g. two separate entries both called
    // "Chasing Amy (1997)"), not something this app can merge. Disambiguate
    // only those specific options so two entries never look identical.
    const titleCounts = new Map();
    for (const movie of movies) {
        titleCounts.set(movie.title, (titleCounts.get(movie.title) || 0) + 1);
    }

    for (const selectId of MOVIE_SELECT_IDS) {
        const selectElement = document.getElementById(selectId);
        if (!selectElement) continue;

        while (selectElement.options.length > 1) {
            selectElement.remove(1);
        }

        sortedMovies.forEach(movie => {
            const option = document.createElement('option');
            option.value = movie.id;
            option.textContent = titleCounts.get(movie.title) > 1
                ? `${movie.title} (id ${movie.id})`
                : movie.title;
            selectElement.appendChild(option);
        });
    }
}

// --- Shared computation lock --------------------------------------------
// Both recommendation modes write to the same #result element and can be
// triggered in quick succession. A single pending-timer id plus disabling
// both buttons means a new run cancels any run still in flight instead of
// racing it and overwriting the result with a stale answer.
let pendingTimeoutId = null;

function getButtons() {
    return [document.getElementById('recommend-btn'), document.getElementById('profile-btn')]
        .filter(Boolean);
}

function beginComputation(loadingMessage) {
    if (pendingTimeoutId !== null) {
        clearTimeout(pendingTimeoutId);
        pendingTimeoutId = null;
    }
    getButtons().forEach(btn => { btn.disabled = true; });

    const resultElement = document.getElementById('result');
    resultElement.textContent = loadingMessage;
    resultElement.className = 'loading';
}

function finishComputation(message, className) {
    pendingTimeoutId = null;
    getButtons().forEach(btn => { btn.disabled = false; });

    const resultElement = document.getElementById('result');
    resultElement.textContent = message;
    resultElement.className = className;
}

function showImmediateError(message) {
    getButtons().forEach(btn => { btn.disabled = false; });
    const resultElement = document.getElementById('result');
    resultElement.textContent = message;
    resultElement.className = 'error';
}

// Item-to-item mode: recommend movies similar to a single selected movie.
function getRecommendations() {
    const selectElement = document.getElementById('movie-select');
    const selectedMovieId = parseInt(selectElement.value, 10);

    if (isNaN(selectedMovieId)) {
        showImmediateError("Please select a movie first.");
        return;
    }

    const likedMovie = movies.find(movie => movie.id === selectedMovieId);
    if (!likedMovie) {
        showImmediateError("Error: Selected movie not found in database.");
        return;
    }

    beginComputation("Calculating recommendations...");

    pendingTimeoutId = setTimeout(() => {
        try {
            const excludeIds = new Set([likedMovie.id]);
            const top5 = Recommender.rankCandidates(movies, likedMovie.vector, movieStats, excludeIds, 5);

            if (top5.length > 0) {
                const titles = top5.map(movie => movie.title);
                finishComputation(
                    `Because you liked "${likedMovie.title}", we recommend: ${titles.join(', ')}`,
                    'success'
                );
            } else {
                finishComputation(`No recommendations found for "${likedMovie.title}".`, 'error');
            }
        } catch (error) {
            console.error('Error in recommendation calculation:', error);
            finishComputation("An error occurred while calculating recommendations.", 'error');
        }
    }, 100);
}

// Profile mode: recommend movies similar to the average genre vector of 3
// movies the user says they've watched.
function getProfileRecommendations() {
    const ids = ['profile-select-1', 'profile-select-2', 'profile-select-3']
        .map(id => parseInt(document.getElementById(id).value, 10));

    if (ids.some(id => isNaN(id))) {
        showImmediateError("Please select 3 movies to build your profile.");
        return;
    }
    if (new Set(ids).size !== ids.length) {
        showImmediateError("Please select 3 different movies.");
        return;
    }

    const watchedMovies = ids.map(id => movies.find(movie => movie.id === id));
    if (watchedMovies.some(movie => !movie)) {
        showImmediateError("Error: one of the selected movies was not found in database.");
        return;
    }

    beginComputation("Calculating profile recommendations...");

    pendingTimeoutId = setTimeout(() => {
        try {
            const profileVector = Recommender.buildProfileVector(watchedMovies.map(movie => movie.vector));
            const excludeIds = new Set(watchedMovies.map(movie => movie.id));
            const top5 = Recommender.rankCandidates(movies, profileVector, movieStats, excludeIds, 5);

            if (top5.length > 0) {
                const watchedTitles = watchedMovies.map(movie => movie.title).join(', ');
                const titles = top5.map(movie => movie.title);
                finishComputation(
                    `Based on your profile (${watchedTitles}), we recommend: ${titles.join(', ')}`,
                    'success'
                );
            } else {
                finishComputation("No profile recommendations found.", 'error');
            }
        } catch (error) {
            console.error('Error in profile recommendation calculation:', error);
            finishComputation("An error occurred while calculating profile recommendations.", 'error');
        }
    }, 100);
}
