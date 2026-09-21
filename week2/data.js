// Data loading module: fetches u.item/u.data and hands the raw text to the
// shared parsing logic in recommender.js, so the browser app and
// analysis.js can never parse the files differently.

let movies = [];
let ratings = [];
let movieStats = new Map();

// Primary function to load data from files
async function loadData() {
    // Reset so loadData() is safe to call more than once (e.g. a future
    // "reload data" action) instead of appending duplicate entries.
    movies = [];
    ratings = [];
    movieStats = new Map();

    try {
        // u.item is Latin-1 (ISO-8859-1) encoded -- e.g. id 543 is
        // "Mis\xe9rables, Les (1995)" -- so it must be decoded explicitly.
        // Response.text() defaults to UTF-8 and would corrupt every
        // accented title (0xE9 is not valid UTF-8 on its own).
        const moviesResponse = await fetch('u.item');
        if (!moviesResponse.ok) {
            throw new Error(`Failed to load movie data: ${moviesResponse.status}`);
        }
        const moviesBuffer = await moviesResponse.arrayBuffer();
        const moviesText = new TextDecoder('iso-8859-1').decode(moviesBuffer);
        movies = Recommender.parseItemData(moviesText);

        // u.data is plain ASCII (ids, tabs, a rating digit, a timestamp),
        // so the default UTF-8 text decoding is fine here.
        const ratingsResponse = await fetch('u.data');
        if (!ratingsResponse.ok) {
            throw new Error(`Failed to load rating data: ${ratingsResponse.status}`);
        }
        const ratingsText = await ratingsResponse.text();
        ratings = Recommender.parseRatingData(ratingsText);

        movieStats = Recommender.computeMovieStats(ratings);
    } catch (error) {
        console.error('Error loading data:', error);
        const resultElement = document.getElementById('result');
        if (resultElement) {
            resultElement.textContent = `Error: ${error.message}. Please make sure u.item and u.data files are in the correct location.`;
            resultElement.className = 'error';
        }
        throw error; // Re-throw to allow script.js to handle the error
    }
}
