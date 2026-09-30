You are an expert full-stack web developer who creates robust, well-commented, and modular web applications using only vanilla HTML, CSS, and JavaScript.

Your task is to generate the complete code for a "Collaborative Filtering Movie Recommender" web application based on the detailed specifications below. The application logic will be split into two separate JavaScript files: `data.js` for data loading and parsing, and `script.js` for UI and recommendation logic. Please provide the code for each of the four files—`index.html`, `style.css`, `data.js`, and `script.js`—separately and clearly labeled.

---

### **Project Specification: Collaborative Filtering Movie Recommender (Modular)**

#### **1. Overall Goal**

Build a single-page web application that recommends movies using **collaborative filtering**. The application will use `data.js` to load and parse the same MovieLens 100K files as the previous exercise (`u.item`, `u.data`)—the dataset is deliberately unchanged so that the **algorithm** is the only thing that changes between the Content-Based assignment and this one.

Unlike the Content-Based version, which compared movie **genres**, this version uses the **rating patterns of users**. It must produce a Top-5 recommendation list **two ways** for the same active user—**User-Based CF** and **Item-Based CF**—so the two lists can be compared side by side.

#### **2. File `index.html` - The Application Structure**

-   **DOCTYPE and Language:** The document should start with `<!DOCTYPE html>` and the `<html>` tag should specify `lang="en"`.
-   **Title:** The page title should be "Collaborative Filtering Movie Recommender".
-   **Main Heading:** Include an `<h1>` with the text "Collaborative Filtering Movie Recommender".
-   **Instructions:** Add a `<p>` tag explaining that the user picks a user and receives two Top-5 lists (one per CF approach).
-   **User Dropdown:** Include a `<select>` element with the ID `user-select`. It will be populated dynamically with one option per user ID present in `u.data`.
-   **Button:** Include a `<button>` with the text "Get Recommendations". When clicked, it must call the `getRecommendations()` JavaScript function.
-   **Result Display Areas:** Include a `<div>` with the ID `result-box`. Inside it, provide two clearly labelled sections:
    -   `<div id="user-based-result">` — for the User-Based CF Top-5
    -   `<div id="item-based-result">` — for the Item-Based CF Top-5

    Each section should show the recommended movie titles together with their predicted score (or similarity), so the two approaches can be compared directly.
-   **File Linking:** Link `data.js` and `script.js` at the end of the `<body>`. `data.js` must be loaded **before** `script.js`.
    ```
    <script src="data.js"></script>
    <script src="script.js"></script>
    ```

#### **3. File `style.css` - The Application Design**

-   **Layout:** Create a professional, modern, and user-friendly layout. All content should be centered on the page within a main container.
-   **Background:** The `<body>` should have a light, neutral background color (e.g., `#f4f7f6`).
-   **Container:** The main container holding all elements should have a white background, rounded corners (`border-radius`), and a subtle box shadow.
-   **Typography:** Use a clean, sans-serif font like 'Helvetica' or 'Arial'.
-   **Controls:** The `<select>` dropdown and `<button>` should have consistent styling.
-   **Button:** Distinct background colour (e.g., a shade of blue), white text, hover effect.
-   **Result Areas:** `#user-based-result` and `#item-based-result` should be visually separated (e.g., two columns on wide screens, stacked on narrow screens) with a light background and a clear heading each.

#### **4. File `data.js` - The Data Handling Module**

This file is responsible only for fetching and parsing the data from local files, and for building the rating structures.

1.  **Global Variables:** Declare `let movies = [];`, `let ratings = [];`, `let numUsers = 0;`, `let numMovies = 0;`, and `let ratingMatrix = null;`.

2.  **Primary Function: `loadData()`**
    -   Must be `async`.
    -   Uses `fetch()` to read `u.item` and `u.data` (same directory as `index.html`).
    -   Uses `try...catch`; on failure, display an error message in the result area.
    -   Awaits `u.item` first, then `u.data`, passing the text to the parsers.
    -   After parsing: set `numUsers` (max user ID in `ratings`), `numMovies` (number of parsed movies), and call `buildRatingMatrix()`.

3.  **Parsing Function: `parseItemData(text)`**
    -   Defines the 18 genre names ("Action" ... "Western").
    -   Splits by lines; each line split by `|`.
    -   Extracts `id` (field 0) and `title` (field 1); builds a `genres` array from the last 19 fields where the value is `'1'`.
    -   Pushes `{ id, title, genres }` to `movies`.

4.  **Parsing Function: `parseRatingData(text)`**
    -   Splits by lines; each line split by `\t`.
    -   Pushes `{ userId, itemId, rating, timestamp }` (numbers) to `ratings`.

5.  **Matrix Function: `buildRatingMatrix()`**
    -   Builds a 2-D structure of shape `(numUsers + 1) × (numMovies + 1)`, where a missing rating is represented by `0`.
    -   Also build a parallel "rated" boolean mask (or use `0` as "not rated") so the similarity function can distinguish *not rated* from *rated 0*.
    -   Store the result in the global `ratingMatrix`.

#### **5. File `script.js` - The UI and Logic Module**

This file handles the user interface and the collaborative-filtering logic.

1.  **Initialization Logic:**
    -   Use `window.onload` with an `async` function.
    -   `await loadData()`, then call `populateUserDropdown()` and set an initial status message.

2.  **UI Function: `populateUserDropdown()`**
    -   Gets the `#user-select` element.
    -   Adds one `<option>` per user ID from `1` to `numUsers`, with the value set to the integer user ID.

3.  **Similarity Function: `cosineSimilarity(a, b)`**
    -   Computes the cosine similarity between two vectors, **using only co-rated (non-zero) entries**.
    -   Must guard against a zero denominator (return `0` in that case).
    -   Include a comment explaining the missing-value convention chosen here and why (see "Missing Value Handling" below).

4.  **Core Logic - User-Based: `getUserBasedRecommendations(activeUserId, topK)`**
    -   Step 1: For every other user, compute `cosineSimilarity` against the active user's rating vector.
    -   Step 2: Select the `N` most similar users (e.g., `N = 20`) with positive similarity.
    -   Step 3: For each movie the active user has **not** rated, compute a predicted score as the similarity-weighted average of the similar users' ratings.
    -   Step 4: Sort the candidates by predicted score (descending) and take the top `topK` (default `5`).
    -   Return an array of `{ title, score }`.

5.  **Core Logic - Item-Based: `getItemBasedRecommendations(activeUserId, topK)`**
    -   Step 1: For each movie the active user has rated, compute item-to-item `cosineSimilarity` between that movie's rating column and every other movie's rating column.
    -   Step 2: For each candidate movie the user has **not** rated, aggregate the similarities from the user's rated movies, weighted by the user's rating.
    -   Step 3: Sort by the aggregated score (descending) and take the top `topK` (default `5`).
    -   Return an array of `{ title, score }`.

6.  **Display Function: `getRecommendations()`**
    -   Reads `#user-select`, converted to an integer.
    -   Calls both `getUserBasedRecommendations()` and `getItemBasedRecommendations()`.
    -   Renders each list into its own section, in the form *"Because you are similar to other users, we recommend: ..."* / *"Because you liked ... we recommend: ..."*.
    -   Handle the empty case gracefully (a user with too few ratings) with a clear message.

#### **6. Missing Value Handling**

The rating matrix is sparse. Pick **exactly one** strategy and apply it consistently in `cosineSimilarity`. State the choice in a comment at the top of `script.js`:

-   **Use co-rated items only** (ignore missing values): the default and simplest.
-   **Mean imputation** — replace missing entries with the row/column average.
-   **Weighted approach** — weight the similarity by the number of co-rated items.

Do not mix strategies.

#### **7. Notes on This Exercise**

-   Do **not** change the dataset files.
-   Keep the modular split (`data.js` / `script.js`); do not move logic between them.
-   The code must run offline from `file://`-like static hosting (GitHub Pages); no build step and no external libraries.

---
Please now generate the complete code for the `index.html`, `style.css`, `data.js`, and `script.js` files based on these final, detailed specifications.

---

## Follow-up prompt / changes after review

The prompt above is the instructor's original and is left as-is. The scaffold it generated had defects (some silent -- wrong data with no error) and a few gaps against the lecture; this section documents what changed and why, once the TODO stubs were implemented.

**Fixes to the provided (non-TODO) code:**

-   **Genre parsing off-by-one** (`data.js`, `parseItemData`): `u.item`'s 24 pipe-delimited fields are `0 id | 1 title | 2 release date | 3 video release date | 4 IMDb URL | 5 "unknown" genre flag | 6..23` the 18 named genre flags (Action..Western). The scaffold sliced from field 5 (`fields.slice(5, 24)`) against the 18-name `genreNames` array, which shifts every genre label one column early and never reads the last (Western) flag at all -- e.g. Toy Story came out `["Children's","Comedy","Crime"]` instead of `["Animation","Children's","Comedy"]`, and 0 movies ever tagged as Western. Fixed by slicing from field 6. (This is a confirmed regression: `week2`'s `data.js` hit and fixed the identical bug on the identical file in commit `4415320`.)
-   **`u.item` encoding** (`data.js`, `loadData`): `u.item` is ISO-8859-1 (9 titles have raw Latin-1 bytes, e.g. movie id 543, "Mis\xe9rables, Les"). The scaffold's `response.text()` assumes UTF-8 and corrupts those bytes to `�`. Fixed via `arrayBuffer()` + `TextDecoder('iso-8859-1')`. Also a confirmed regression of a `week2` fix.
-   **`loadData()` error handling** only wrote to `#user-based-result` on failure, leaving `#item-based-result` (and now `#predict-result`) stuck on "Loading...". Fixed to update all result areas.
-   **`numMovies = movies.length`** silently diverges from the true max movie id if `parseItemData` ever skips a malformed line (it currently doesn't, on this dataset, but nothing guaranteed that). Changed to the max id actually parsed.
-   **`renderList()`**'s empty-case message was a placeholder for the unfinished TODO stubs ("Implement the TODO above"), not a real user-facing message, and it never rendered the "Because you are similar to..." / "Because you liked..." framing section 5.6 asks for. Both fixed; this is a change to code originally labelled "Provided" because the spec can't be met without changing it.
-   **No busy-state / double-click guard** on "Get Recommendations": nothing disabled the button during computation or on initial load, so a click before data finished loading would throw. Fixed with a shared `withBusyUI()` helper (disables the button, shows a "Computing..." label, re-enables after).

**Deliberate deviations from this prompt, and why:**

-   **Missing-value strategy** (section 6): weighted by co-rated count -- `weightedSimilarity = cosineSimilarity(co-rated only) * min(n, 50) / 50`. On this data, two users (or movies) sharing exactly one rated item get raw cosine `1.0` 100% of the time, and raw cosine barely varies with support at all (`0.9391` avg at n=5, `0.9437` at n>=50) -- ratings are 1-5 only, so almost any two positive rating vectors point nearly the same direction regardless of how much they actually have in common. This is a **mitigation for neighbor selection**, not a fix for everything: `Pearson r(n, weighted similarity) = 0.87` across all 429,110 co-rating user pairs, meaning weighted similarity ends up driven mostly by *how much* co-rated evidence exists, not by the *shape* of agreement. It also does **not** touch an item's own baseline mean -- see the minimum-support point below, which is a separate mechanism for a separate problem. (Figures reproduced by `analysis.js`.)
-   **Prediction formula** (sections 5.4/5.5): the lecture's mean-centered formula is used instead of a plain similarity-weighted average: `predicted = baseline + sum(sim * (rating - mean)) / sum(|sim|)`, baseline = the active user's own mean (user-based) or the target movie's own mean (item-based), over neighbors with positive similarity only, top `N = 20`. **Clamped to [1, 5]**: baseline and each neighbor's deviation come from different users'/items' own means, so nothing in the formula otherwise guarantees the sum stays on the rating scale -- measured on real data, the unclamped version puts 3.04% of predictions outside [1, 5] (as far out as -0.55 to 6.90).
-   **Minimum support for Top-5 candidates**: `MIN_ITEM_RATINGS = 5` (candidate must have that many ratings total) and `MIN_NEIGHBOURS = 3` (that many neighbors must actually contribute to its predicted score). Not in this prompt at all, and not the same problem the weighting above addresses: an item's baseline is its own mean rating, untouched by any similarity weighting -- a movie with a single 5-star rating has baseline 5.0 regardless. Measured before this filter, on real data across all 943 users: item-based Top-5 slots were **88.8%** movies with fewer than 5 total ratings; user-based, **9.2%**. After the filter: **0%** for both, and no user is left with an empty list. (Full before/after table in `analysis.js`'s output.)
-   **`0` as "not rated" instead of a separate boolean mask** (section 4.5): `u.data` ratings are verified to be integers 1-5 only (no `0` ratings occur), so `0` is already unambiguous and a parallel mask would be redundant.
-   **`cosineSimilarity(a, b)` takes two sparse `Map<id, rating>`**, not the dense array slices section 5.3 describes. Slicing a full 1683- or 944-length row/column per comparison is the exact performance problem the item-based side has (see below); the co-rated-only computation is identical either way, just without materializing zeros.
-   **Item-item similarity is precomputed once, after load** (`buildItemSimilarityCache()`), rather than per click as section 5.5 step 1 implies. As specified (recompute for each of a user's rated movies against every other movie, every click), item-based CF costs roughly `ratedByUser x numMovies x numUsers` scalar ops per request -- ~168M for an average user, enough to visibly freeze the tab. Precomputing once costs ~`numMovies^2/2` sparse comparisons (~1.4M pairs) and was measured at ~960ms-1s on this dataset; every Top-5/Predict Rating request after that is a `Float32Array` lookup (2-46ms measured).
-   **Extra "Predict Rating" UI** (`#movie-select` + `#predict-btn` -> `#predict-result`): not in this prompt, but required by the lecture's mockup (`Select User` + `Select Movie` -> `Predict Rating` -> two numbers side by side). Uses the same prediction functions as the Top-5 lists, evaluated for one chosen `(user, movie)` pair; unlike Top-5 it does not apply the minimum-support filter above (informational lookup, not a ranked list) -- it shows whatever support it has, annotated with the neighbor count (e.g. "3.7 predicted (12 neighbours)"), and only declines to show a number when there are zero contributing neighbors.

**Second-pass fixes (after further review):**

-   **Deterministic Top-5 tie-break**: clamping to `[1, 5]` means many distinct candidates legitimately predict to exactly `5.000` -- measured on real data, 248/943 users had an all-`5.000` user-based Top-5 (82/943 item-based), and 235/943 / 66/943 had a score tie right at the 5th/6th-place cutoff. Without a tie-break, `Array.sort`'s stability means ties fall back to whichever order `movies` was built in, i.e. `u.item`'s file order -- not a measure of anything. Added `compareCandidates()`: score desc, then `k` (contributing neighbours) desc, then total rating count desc, then title asc, and now display `k` in every Top-5 entry (`"Title — 5.000 (12 neighbours)"`). This changes the actual Top-5 *set* (not just its order) for 217/943 users (user-based) / 61/943 (item-based) -- see `analysis.js`'s before/after tie-count section.
-   **`requestAnimationFrame` alone does not guarantee a paint**: its callback runs *before* the browser paints that frame, so synchronous work done inside it (the ~1s item-similarity precompute in `window.onload`, or a Top-5/Predict Rating computation in `withBusyUI`) still delays the very paint meant to show "Preparing recommendations..." / "Computing...". Fixed with the double-yield pattern, `requestAnimationFrame(() => setTimeout(resolve, 0))`, in both places. Relatedly, `withBusyUI`'s button re-enable is now also deferred one more `setTimeout(0)`: clicks that arrive while the main thread is blocked are queued by the browser and only dispatched once the blocking task finishes, so re-enabling the button synchronously right after the work would let the first queued click slip through the disabled-button guard.
-   **Predict Rating now also shows "Actual rating: X"** when the selected user already rated the selected movie, as a sanity check alongside the two predictions (which are computed the normal way regardless -- nothing is excluded).
-   **`#movie-select` disambiguates duplicate titles**: 18 titles in `u.item` are shared by two different ids (e.g. two distinct "Chasing Amy (1997)"). Those entries now show `"Title (id N)"`; every other (non-duplicated) title is unaffected.
