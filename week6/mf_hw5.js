/**
 * week6/mf_hw5.js - the student's OWN Homework 5 matrix factorization, evaluated
 * under the week6 retrieval protocol (readme section 6: "reuse your previous
 * implementation and selected model").
 *
 * SOURCE: the five functions between the "BEGIN VERBATIM" / "END VERBATIM"
 * markers are copied verbatim (only indented by two spaces) from
 * `week5/script.js` at commit a65ef5d ("HW5: implement matrix factorization with
 * TensorFlow.js (6 TODO stubs)"): isTfModel, computeRMSEFor, initializeFactors,
 * trainMF, selectBestCheckpoint. Settings are the HW5 defaults: 16 factors,
 * seed 42, Adam lr 0.01, L2 0.05 on the batch rows, batch 64, 20 epochs,
 * best-validation-RMSE epoch restored.
 *
 * Loaded ONLY by `compare_hw5_mf.html`, after data.js / graph.js / script.js.
 * It never edits a provided file. Flow:
 *   1. wait for the provided bootstrap (`HW6_STATE.loaded`);
 *   2. train the PROVIDED instructor MF reference first (`hw6EnsureMfForNeed`)
 *      and keep it, untouched, as `window.HW6_INSTRUCTOR_MF`;
 *   3. train the HW5 model on `HW6_SPLIT` (same chronological split);
 *   4. swap its tensors into `HW6_MF_MODEL` (identical layout: userFactors
 *      [numUsers + 1, F] and itemFactors [maxMovieId + 1, F] indexed by raw ids,
 *      plus globalMean), so the PROVIDED `mfScores`, cohort, candidate pool and
 *      exclusion rules score it, and the page's "mf" method / row means HW5 MF;
 *   5. update `MF_INFO` to describe the model actually in use (`model` field
 *      names the commit); the instructor record stays in `HW6_INSTRUCTOR_MF.info`.
 * HW5 scores are globalMean + p_u . q_i (not clamped), as in HW5's Top-K.
 *
 * Status is written to `#hw5-mf-status`. `window.HW5_MF_READY` resolves when the
 * swap is done (or with an error record).
 */
(function () {
  const NUM_FACTORS = 16;
  let model = null;
  let trainingHistory = [];

  // ---------------- BEGIN VERBATIM (a65ef5d:week5/script.js) ----------------
  /**
   * True when `candidate` is a TF.js factor model (dense `tf.Variable` rows).
   *
   * Used to route `computeRMSEFor` through the batched tensor path and to keep
   * the fixture-based tests independent of how the model was produced.
   *
   * @param {*} candidate
   * @returns {boolean}
   */
  function isTfModel(candidate) {
    return (
      !!candidate &&
      !!candidate.userFactors &&
      typeof candidate.userFactors.dataSync === "function" &&
      !!candidate.itemFactors &&
      typeof candidate.itemFactors.dataSync === "function"
    );
  }

  /**
   * Root-mean-square error of the current model over a split.
   *
   * Provided so that `trainMF` and the test harness share one implementation.
   *
   * When `model` holds TF.js variables this builds the index tensors ONCE, uses
   * `tf.gather` + element-wise multiply to score every rating in a single batch,
   * and clamps to `[1, 5]` — the same contract as `predictRating`, but fast
   * enough to call every epoch. Out-of-range ids fall back to `globalMean`, and
   * the whole computation runs inside `tf.tidy` so the intermediate tensors are
   * released automatically.
   *
   * When no TF.js model is available it falls back to the scalar
   * `predictRating` loop. That path returns `NaN` instead of throwing while
   * `predictRating` is still a `TODO(hw5)` stub, so the helper never crashes the
   * page or the harness.
   *
   * @param {Rating[]} split
   * @returns {number} `0` for an empty split; `NaN` if the scalar path throws.
   */
  function computeRMSEFor(split) {
    if (!split || split.length === 0) return 0;

    if (isTfModel(model)) {
      return tf.tidy(() => {
        const n = split.length;
        const uRows = model.userFactors.shape[0];
        const iRows = model.itemFactors.shape[0];
        const userIds = new Int32Array(n);
        const movieIds = new Int32Array(n);
        const actual = new Float32Array(n);
        const valid = new Float32Array(n);

        for (let k = 0; k < n; k++) {
          const r = split[k];
          userIds[k] = r.userId;
          movieIds[k] = r.movieId;
          actual[k] = r.rating;
          const uOk = r.userId >= 0 && r.userId < uRows;
          const iOk = r.movieId >= 0 && r.movieId < iRows;
          valid[k] = uOk && iOk ? 1 : 0;
        }

        const uIdx = tf.clipByValue(tf.tensor1d(userIds, "int32"), 0, Math.max(0, uRows - 1));
        const iIdx = tf.clipByValue(tf.tensor1d(movieIds, "int32"), 0, Math.max(0, iRows - 1));
        const u = tf.gather(model.userFactors, uIdx);
        const i = tf.gather(model.itemFactors, iIdx);
        const dot = tf.sum(tf.mul(u, i), 1);
        const mask = tf.tensor1d(valid, "float32");
        const pred = tf.clipByValue(dot.mul(mask).add(model.globalMean), 1, 5);
        const diff = pred.sub(tf.tensor1d(actual, "float32"));
        return Math.sqrt(tf.mean(diff.square()).dataSync()[0]);
      });
    }

    let sum = 0;
    try {
      for (const r of split) {
        const diff = predictRating(r.userId, r.movieId) - r.rating;
        sum += diff * diff;
      }
    } catch (error) {
      return Number.NaN;
    }
    return Math.sqrt(sum / split.length);
  }

  /**
   * Allocate the latent factor variables and the global mean.
   *
   * Task (hw5): compute `globalMean` as the mean rating over `train`
   * (`0` for an empty training set), then create the two dense variables:
   * ```js
   * const maxMovieId = movies.reduce((m, x) => Math.max(m, x.id), 0);
   * model = {
   *   userFactors: tf.variable(tf.randomNormal([numUsers + 1, numFactors], 0, 0.05)),
   *   itemFactors: tf.variable(tf.randomNormal([maxMovieId + 1, numFactors], 0, 0.05)),
   *   globalMean,
   * };
   * ```
   * `tf.randomNormal(shape, mean, std)` draws small values — use a small std
   * (e.g. `0.05`) so training starts near the global mean. `tf.variable` wraps a
   * tensor so the optimizer can update it in place. Store the result on the
   * module-level `model` object and return it.
   *
   * Contract:
   *  - `numFactors` defaults to the module-level `NUM_FACTORS`.
   *  - If a previous `model` exists, dispose its variables (`tf.dispose`) before
   *    replacing it so repeated "Train" clicks do not leak GPU memory.
   *  - Return the `model` object.
   *
   * Implementation notes (hw5):
   *  - `seed` (default 42) is passed to `tf.randomNormal` so a run is
   *    reproducible; it is also stored as `model.seed` and reused by `trainMF`
   *    for the batch shuffle.
   *  - The variables are created inside `tf.tidy`, so the `randomNormal`
   *    initial values are released (the bare `tf.variable(tf.randomNormal(...))`
   *    pattern above leaks one tensor per variable).
   *  - User rows = max(`numUsers`, highest user id in `train`) + 1, so the model
   *    is valid even before `numUsers` is set.
   *
   * @param {Rating[]} train
   * @param {number} [numFactors=NUM_FACTORS]
   * @param {number} [seed=42] seed for the random initialization and the shuffle
   * @returns {Model}
   */
  function initializeFactors(train, numFactors = NUM_FACTORS, seed = 42) {
    const globalMean = train.length
      ? train.reduce((acc, r) => acc + r.rating, 0) / train.length
      : 0;
    const maxMovieId = movies.reduce((m, x) => Math.max(m, x.id), 0);
    const maxUserId = train.reduce((m, r) => Math.max(m, r.userId), numUsers);

    if (model) tf.dispose([model.userFactors, model.itemFactors]);

    const [userFactors, itemFactors] = tf.tidy(() => [
      tf.variable(tf.randomNormal([maxUserId + 1, numFactors], 0, 0.05, "float32", seed)),
      tf.variable(tf.randomNormal([maxMovieId + 1, numFactors], 0, 0.05, "float32", seed + 1)),
    ]);
    model = { userFactors, itemFactors, globalMean, seed };
    return model;
  }

  /**
   * Train the factorization with batched gradient descent.
   *
   * Task (hw5): run a mini-batch loop over `train` using the TF.js optimizer.
   * Score each batch with tensor ops (never one `tf` call per rating) and let the
   * optimizer update both variables in place:
   * ```js
   * const optimizer = tf.train.adam(lr);
   * for (let epoch = 1; epoch <= epochs; epoch++) {
   *   for (const batch of batches) {
   *     optimizer.minimize(() => tf.tidy(() => {
   *       const u = tf.gather(model.userFactors, batch.userIdx);
   *       const i = tf.gather(model.itemFactors, batch.itemIdx);
   *       const pred = tf.sum(u.mul(i), 1).add(model.globalMean);
   *       const mse = tf.losses.meanSquaredError(batch.targets, pred);
   *       const l2 = model.userFactors.square().sum()
   *         .add(model.itemFactors.square().sum()).mul(reg);
   *       return mse.add(l2);
   *     }), false, [model.userFactors, model.itemFactors]).dispose();
   *   }
   *   trainingHistory.push({
   *     epoch,
   *     trainRMSE: computeRMSEFor(train),
   *     valRMSE: computeRMSEFor(val),
   *   });
   * }
   * return trainingHistory;
   * ```
   * Key TF.js APIs to use: `tf.train.adam(lr)` (or `tf.train.sgd`),
   * `optimizer.minimize(fn, returnCost, varList)`, `tf.gather`,
   * `tf.losses.meanSquaredError`, and `tf.tidy` for per-batch intermediates.
   * `minimize` returns a scalar loss tensor — dispose it (or use `tf.tidy`) so
   * the loop does not accumulate tensors.
   *
   * Contract:
   *  - `opts = { epochs, lr, reg, batchSize }`. Use mini-batches of `batchSize`
   *    (or full-batch when `batchSize >= train.length`).
   *  - Update `model` in place. Do NOT reallocate it.
   *  - Append one `HistoryRow` per epoch to the module-level `trainingHistory`
   *    and return it: `{ epoch, trainRMSE: computeRMSEFor(train),
   *    valRMSE: computeRMSEFor(val) }`. `epoch` is 1-based.
   *  - Shuffling the batch order each epoch is allowed and usually helps.
   *  - Guard `train.length === 0` by returning an empty history.
   *
   * Implementation notes (hw5) — where this differs from the example above:
   *  - L2 penalizes only the rows gathered for the batch:
   *    `reg * mean_batch(||p_u||^2 + ||q_i||^2)`. The example's penalty on EVERY
   *    row of both matrices on every batch drives all factors to 0 at the
   *    default `reg = 0.05` (the model collapses to the global-mean baseline).
   *  - `optimizer.minimize(fn, false, varList)` returns `null`, so its result is
   *    not disposed; the optimizer itself is disposed after the last epoch.
   *  - The batch order is shuffled every epoch with a PRNG seeded from
   *    `model.seed` (set by `initializeFactors`), so a run is reproducible.
   *  - `trainingHistory` is reset at the start, so repeated "Train" clicks do not
   *    append to the previous run's history.
   *  - Checkpoint restore: after every epoch whose `valRMSE` is strictly smaller
   *    than the best so far (the earliest minimum, the same rule as
   *    `selectBestCheckpoint`), both matrices are cloned. After the last epoch
   *    the clones are written back into the EXISTING variables with `assign()`
   *    and disposed, so `model` equals the selected checkpoint. Skipped when
   *    `val` is empty.
   *  - Only `train` and `val` are read; the test split is never touched here.
   *
   * @param {Rating[]} train
   * @param {Rating[]} val
   * @param {TrainOptions} opts
   * @returns {HistoryRow[]}
   */
  function trainMF(train, val, opts) {
    trainingHistory = [];
    if (!train || train.length === 0 || !model) return trainingHistory;

    const { epochs, lr, reg, batchSize } = opts;
    const n = train.length;
    const size = Math.max(1, Math.min(batchSize, n));

    // mulberry32: small seeded PRNG for a reproducible shuffle.
    let state = ((model.seed === undefined ? 42 : model.seed) + 7) | 0;
    const random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Index / target tensors are built once and gathered per batch.
    const userIdx = tf.tensor1d(Int32Array.from(train, (r) => r.userId), "int32");
    const itemIdx = tf.tensor1d(Int32Array.from(train, (r) => r.movieId), "int32");
    const targets = tf.tensor1d(Float32Array.from(train, (r) => r.rating), "float32");

    const optimizer = tf.train.adam(lr);
    const varList = [model.userFactors, model.itemFactors];
    const order = new Int32Array(n);
    let best = null; // { valRMSE, userFactors, itemFactors } clones of the best epoch

    for (let epoch = 1; epoch <= epochs; epoch++) {
      for (let k = 0; k < n; k++) order[k] = k;
      for (let k = n - 1; k > 0; k--) {
        const j = Math.floor(random() * (k + 1));
        const tmp = order[k];
        order[k] = order[j];
        order[j] = tmp;
      }
      const perm = tf.tensor1d(order, "int32");

      for (let start = 0; start < n; start += size) {
        const len = Math.min(size, n - start);
        optimizer.minimize(
          () =>
            tf.tidy(() => {
              const idx = perm.slice(start, len);
              const u = tf.gather(model.userFactors, tf.gather(userIdx, idx));
              const i = tf.gather(model.itemFactors, tf.gather(itemIdx, idx));
              const pred = tf.sum(u.mul(i), 1).add(model.globalMean);
              const mse = tf.losses.meanSquaredError(tf.gather(targets, idx), pred);
              const l2 = u.square().sum(1).add(i.square().sum(1)).mean().mul(reg);
              return mse.add(l2);
            }),
          false,
          varList,
        );
      }
      perm.dispose();

      const row = { epoch, trainRMSE: computeRMSEFor(train), valRMSE: computeRMSEFor(val) };
      trainingHistory.push(row);

      if (val.length > 0 && Number.isFinite(row.valRMSE) && (!best || row.valRMSE < best.valRMSE)) {
        if (best) tf.dispose([best.userFactors, best.itemFactors]);
        best = {
          valRMSE: row.valRMSE,
          userFactors: tf.clone(model.userFactors),
          itemFactors: tf.clone(model.itemFactors),
        };
      }
    }

    if (best) {
      model.userFactors.assign(best.userFactors);
      model.itemFactors.assign(best.itemFactors);
      tf.dispose([best.userFactors, best.itemFactors]);
    }
    optimizer.dispose();
    tf.dispose([userIdx, itemIdx, targets]);
    return trainingHistory;
  }

  /**
   * Pick the best epoch from a training history.
   *
   * Task (hw5): return the entry with the smallest `valRMSE`. On a tie return the
   * entry with the EARLIEST `epoch` (do not simply take the last minimum). This
   * one is plain JavaScript — no TF.js needed.
   *
   * Contract:
   *  - Return `null` for an empty or missing history.
   *  - Do not mutate the input array.
   *
   * @param {HistoryRow[]} history
   * @returns {HistoryRow|null}
   */
  function selectBestCheckpoint(history) {
    if (!Array.isArray(history) || history.length === 0) return null;
    let best = null;
    for (const row of history) {
      if (!row || !Number.isFinite(row.valRMSE)) continue;
      if (
        !best ||
        row.valRMSE < best.valRMSE ||
        (row.valRMSE === best.valRMSE && row.epoch < best.epoch)
      ) {
        best = row;
      }
    }
    return best;
  }
  // ----------------- END VERBATIM (a65ef5d:week5/script.js) -----------------

  const HW5_CONFIG = { factors: 16, seed: 42, epochs: 20, lr: 0.01, reg: 0.05, batchSize: 64 };

  window.HW5_MF_INFO = {
    commit: "a65ef5d",
    config: HW5_CONFIG,
    checkpoint: null,
    validationRMSE: null,
    testRMSE: null,
    history: [],
    seconds: null,
    swappedAt: null,
    error: null,
  };

  const setStatus = function (text) {
    const el = document.getElementById("hw5-mf-status");
    if (el) el.textContent = text;
  };

  const waitForBootstrap = async function () {
    for (let k = 0; k < 1200; k++) {
      if (typeof HW6_STATE !== "undefined" && HW6_STATE.loaded) return true;
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
    return false;
  };

  const run = async function () {
    const info = window.HW5_MF_INFO;
    try {
      if (!(await waitForBootstrap())) throw new Error("the provided bootstrap did not finish (data or TF.js missing)");
      setStatus("Training the provided instructor MF reference first\u2026");
      await hw6EnsureMfForNeed();
      if (!HW6_MF_MODEL || MF_INFO.trainedAt === null) throw new Error("the provided MF reference could not be trained");
      window.HW6_INSTRUCTOR_MF = {
        model: HW6_MF_MODEL,
        info: Object.assign({}, MF_INFO, { history: MF_INFO.history.slice() }),
      };

      setStatus("Training HW5 MF (a65ef5d): " + HW5_CONFIG.epochs + " epochs, batch " + HW5_CONFIG.batchSize + "\u2026");
      await tf.nextFrame();
      const started = performance.now();
      initializeFactors(HW6_SPLIT.train, HW5_CONFIG.factors, HW5_CONFIG.seed);
      trainMF(HW6_SPLIT.train, HW6_SPLIT.val, HW5_CONFIG);
      const best = selectBestCheckpoint(trainingHistory);
      info.history = trainingHistory.slice();
      info.checkpoint = best ? best.epoch : null;
      info.validationRMSE = best ? best.valRMSE : null;
      info.testRMSE = computeRMSEFor(HW6_SPLIT.test);
      info.seconds = (performance.now() - started) / 1000;

      HW6_MF_MODEL = { userFactors: model.userFactors, itemFactors: model.itemFactors, globalMean: model.globalMean };
      Object.assign(MF_INFO, {
        model: "student HW5 MF, commit a65ef5d (week6/mf_hw5.js)",
        factors: HW5_CONFIG.factors,
        epochs: HW5_CONFIG.epochs,
        learningRate: HW5_CONFIG.lr,
        regularization: HW5_CONFIG.reg,
        batchSize: HW5_CONFIG.batchSize,
        seed: HW5_CONFIG.seed,
        checkpoint: info.checkpoint,
        validationRMSE: info.validationRMSE,
        history: info.history,
        trainedAt: new Date().toISOString(),
      });
      hw6InvalidateCaches();
      HW6_STATE.comparisonRows = null;
      info.swappedAt = MF_INFO.trainedAt;
      setStatus("HW5 MF ready and active as method \u201cmf\u201d: checkpoint epoch " + info.checkpoint +
        ", validation RMSE " + info.validationRMSE.toFixed(4) + ", test RMSE " + info.testRMSE.toFixed(4) +
        ". The instructor reference is kept as HW6_INSTRUCTOR_MF.");
    } catch (error) {
      info.error = String(error && error.message ? error.message : error);
      setStatus("HW5 MF unavailable: " + info.error);
    }
    return info;
  };

  window.HW5_MF_READY = run();
})();
