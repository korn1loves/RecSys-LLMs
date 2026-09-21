You are an expert full-stack web developer who creates robust, well-commented, and modular web applications using only vanilla HTML, CSS, and JavaScript.

Your task is to generate the complete code for a "Content-Based Movie Recommender" web application based on the detailed specifications below. The application logic is split into three JavaScript files: `recommender.js` for the pure parsing/scoring/ranking logic (shared with an offline Node analysis script, so it must not touch the DOM or any browser-only API), `data.js` for fetching the data files and handing their text to `recommender.js`, and `script.js` for UI wiring. Please provide the code for each of the five files -- `index.html`, `style.css`, `recommender.js`, `data.js`, and `script.js` -- separately and clearly labeled.

---

### **Project Specification: Content-Based Movie Recommender (Modular)**

#### **1. Overall Goal**

Build a single-page web application that recommends movies from the MovieLens 100K dataset (`u.item`, `u.data`), using **cosine similarity over genre vectors**. Support two modes:
- **Item-to-item:** pick one movie you like, get the Top-5 most similar movies.
- **Profile:** pick 3 movies you've watched, get the Top-5 movies most similar to the *average* of their genre vectors.

#### **2. Source data -- read this before writing any parsing code**

- `u.item` is pipe (`|`) delimited, 24 fields per line: `id | title | release date | video release date | IMDb URL | unknown-genre-flag | 18 named genre flags (Action..Western, in that exact order)`. There are **19** genre flags in total (fields 6-24, 1-indexed) but only **18** of them are real genres -- the first one (field 6) is a placeholder "unknown" flag that is not a genre and must be **dropped**, not zipped against the 18 genre names. Concretely: take `fields[6..23]` (0-indexed slice `fields.slice(6, 24)`), and match those 18 values 1:1 against the 18-name genre list `Action, Adventure, Animation, Children's, Comedy, Crime, Documentary, Drama, Fantasy, Film-Noir, Horror, Musical, Mystery, Romance, Sci-Fi, Thriller, War, Western`.
- `u.item` is **Latin-1 (ISO-8859-1) encoded**, not UTF-8 (e.g. movie id 543 is `Misérables, Les (1995)`, stored with raw byte `0xE9` for "é"). It must be decoded explicitly with that charset (e.g. read as an `ArrayBuffer` and decode with `TextDecoder('iso-8859-1')`); do not rely on `Response.text()`'s default UTF-8 decoding, which would corrupt every accented title.
- `u.item` contains a small number of movies with **all 18 named-genre flags set to 0** (only the dropped "unknown" flag is set) -- e.g. id 267 and id 1373. These movies legitimately have an empty genre vector; any similarity computation must treat this as "no signal" (score 0), never divide by zero.
- `u.item` also contains a handful of **duplicate titles** under different ids (e.g. two different entries both titled `"Chasing Amy (1997)"`). The UI must keep both selectable and make them visually distinguishable, since the title text alone is not unique.
- `u.data` is tab-delimited, 4 fields per line (`userId`, `itemId`, `rating`, `timestamp`), plain ASCII -- no special decoding needed.

#### **3. File `index.html` - The Application Structure**

- **DOCTYPE and Language:** The document should start with `<!DOCTYPE html>` and the `<html>` tag should specify `lang="en"`.
- **Title:** The page title should be "Content-Based Movie Recommender".
- **Main Heading:** Include an `<h1>` with the text "Content-Based Movie Recommender".
- **Instructions:** Add a `<p>` tag with instructions like, "Select a movie you like, and we'll find similar ones for you!"
- **Item-to-item controls:** A `<select>` with id `movie-select`, populated dynamically, and a `<button id="recommend-btn">` reading "Get Recommendations" that calls `getRecommendations()`.
- **Profile controls:** Three `<select>` elements (e.g. `profile-select-1/2/3`), each populated the same way as `movie-select`, plus a `<button id="profile-btn">` reading "Get Profile Recommendations" that calls `getProfileRecommendations()`.
- **Result Display Area:** Include a `<div>` with the ID `result-box`. Inside this div, add a `<p>` tag with the ID `result`. Both recommendation modes write into this same element.
- **File Linking:** At the end of the `<body>`, link all three scripts in dependency order:
    ```
    <script src="recommender.js"></script>
    <script src="data.js"></script>
    <script src="script.js"></script>
    ```

#### **4. File `style.css` - The Application Design**

- **Layout:** Create a professional, modern, and user-friendly layout. All content should be centered on the page within a main container.
- **Background:** The `<body>` should have a light, neutral background color (e.g., `#f4f7f6`).
- **Container:** The main container holding all elements should have a white background, rounded corners (`border-radius`), and a subtle box shadow to make it pop.
- **Typography:** Use a clean, sans-serif font like 'Helvetica' or 'Arial'.
- **Controls:** All `<select>` dropdowns and both buttons share consistent styling (e.g. a common `.movie-picker` / `.action-btn` class), with adequate padding and a clear visual hierarchy. Give disabled buttons a visibly muted state.
- **Result Area:** The `#result-box` should have some padding and a light background to separate it from the controls. The recommendation text inside `#result` should be bold and easy to read.

#### **5. File `recommender.js` - Shared parsing and recommendation logic**

This file contains **only pure functions and data structures** -- no `fetch`, no `document`, no `window`. It must run unmodified under both a `<script>` tag in the browser and Node's `require()` (export via `module.exports` when available, otherwise attach to the global object), so that an offline analysis script can reuse the exact same formulas the app uses, with zero duplication.

1. **`GENRE_NAMES`**: the 18 genre names, Action through Western, in file order (see section 2).
2. **`parseItemData(text)`**: parse `u.item` text per section 2's field layout. For each line, build `{ id, title, genres, vector }`, where `vector` is the 18-element binary array (in `GENRE_NAMES` order) and `genres` is the filtered list of genre names present.
3. **`parseRatingData(text)`**: parse `u.data` text into `{ userId, itemId, rating, timestamp }` objects.
4. **`computeMovieStats(ratings)`**: one pass over ratings, returning a `Map` from `itemId` to `{ count, avg }` (rating count and average rating). This is the popularity signal used for tie-breaking below.
5. **`cosineSimilarity(a, b)`**: cosine similarity between two equal-length numeric vectors: `dot(a,b) / (||a|| * ||b||)`. If either vector's magnitude is 0, return `0` -- never `NaN`.
6. **`buildProfileVector(vectors)`**: the elementwise mean of several genre vectors.
7. **`rankCandidates(allMovies, queryVector, statsMap, excludeIds, topN)`**: score every movie not in `excludeIds` via `cosineSimilarity`, then sort descending by:
   1. score,
   2. rating count (from `statsMap`) -- an explicit popularity tie-break, not an accident of array order,
   3. average rating,
   4. movie id ascending, as a final deterministic fallback.
   Return the first `topN`. Document in a comment that the popularity tie-break is a deliberate signal whose effect on long-tail catalog exposure should be measured, not assumed benign.

#### **6. File `data.js` - Fetching and decoding**

1. **Global Variables:** `let movies = []`, `let ratings = []`, `let movieStats = new Map()`.
2. **`loadData()`** (`async`):
   - Reset `movies`, `ratings`, and `movieStats` at the top, so the function is safe to call more than once.
   - `await fetch('u.item')`, decode the response as Latin-1 (`arrayBuffer()` + `TextDecoder('iso-8859-1')`, per section 2), and pass the resulting text to `Recommender.parseItemData`.
   - `await fetch('u.data')`, decode as text (default UTF-8 is fine -- the file is plain ASCII), and pass it to `Recommender.parseRatingData`.
   - Compute `movieStats = Recommender.computeMovieStats(ratings)`.
   - Wrap all of the above in `try...catch`; on failure, display an error message in `#result` and re-throw.

#### **7. File `script.js` - UI wiring**

1. **Initialization:** `window.onload` is an `async` function that shows a loading message, `await`s `loadData()`, then calls a function that populates every movie `<select>` (the single item-to-item picker and the three profile pickers) from the sorted `movies` array. For any title shared by more than one movie (see section 2), disambiguate the option text (e.g. append the movie id) so the two options are never visually identical.
2. **`getRecommendations()`** (item-to-item):
   - Read and validate the selected movie id from `movie-select`; look up `likedMovie`; show an error and stop if not found.
   - Show a "Calculating..." message, then (after the async UI update) rank candidates via `Recommender.rankCandidates(movies, likedMovie.vector, movieStats, new Set([likedMovie.id]), 5)` and display the Top-5 titles.
3. **`getProfileRecommendations()`** (profile mode):
   - Read and validate exactly 3 distinct, found movies from the three profile selects.
   - Build the profile vector via `Recommender.buildProfileVector`, exclude **all three** selected movies from the candidate pool, rank via `Recommender.rankCandidates`, and display the Top-5 titles.
4. **Robustness (both modes):**
   - Keep a module-level pending-timer id; before scheduling a new computation, `clearTimeout` any timer still pending, so a rapid second click cannot let a stale computation overwrite a newer result.
   - Disable both action buttons while a computation is in flight, and re-enable them on every exit path (success, empty result, and error).

---
Please now generate the complete code for the `index.html`, `style.css`, `recommender.js`, `data.js`, and `script.js` files based on these final, detailed specifications.
