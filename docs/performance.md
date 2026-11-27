# Rendering and sharing performance

## Recorded comparison

Baseline: `0f1de0115d203dec40dc9e4643989407047ea804`. Measured November 27, 2026 on an Apple M3 Pro, Node 24.22.1, Chromium 159.0.8154.6 with ANGLE Metal. Both versions use the same synthetic inputs and balanced rendering settings.

The browser benchmark uses 2,400 sessions, a 1440 × 1000 viewport at 1× device scale, reduced motion, and five fresh browser processes. The publishing benchmark uses an in-memory SQLite library with 1,200 sessions and 300,000 events, each with a 2,186-byte invented payload; seven timed runs follow one warmup.

| Operation | Baseline median | Optimized median | Improvement |
| --- | ---: | ---: | ---: |
| First session cards inserted | 361 ms | 184 ms | 49% less time |
| Reach the oldest session | 3,001 ms | 24 ms | 99% less time |
| Mounted cards at the oldest session | 2,400 | 8 | Bounded visible window |
| Search scroll main-thread work | 197 ms | 42 ms | 79% less work |
| Search scroll layout work | 30.8 ms | 0.41 ms | 99% less work |
| Search rows inserted during small scrolls | 780 | 0 | Existing rows reused |
| Fit view handler | 31.9 ms | 2.0 ms | 94% less time |
| Rebuild picking index (CPU) | 1.0 ms | 0.5 ms | 50% less time |
| Node-buffer rebuilds for 23 uniform-only redraws | 23 | 0 | No unnecessary uploads |
| Prepare publishing snapshot in SQLite | 366 ms | 72 ms | 80% less time (5.1× faster) |
| Open publishing viewer, mocked API | 315 ms | 252 ms | 20% less time |
| Change publishing details, mocked API | 231 ms | 110 ms | 53% less time |

The recorded summaries and tail timings are in `benchmarks/performance.json`. Raw run outputs go to ignored `tmp/performance/`.

### Interpretation

- Oldest-session access measures the same destination: the old UI expands every “Show more” page, while the virtual list jumps directly to the last row. The benchmark verifies the destination ID.
- Search scrolls 2 pixels per frame for 60 frames. It measures CDP `TaskDuration` / `LayoutDuration` deltas and observes DOM insertions. It pauses conversation indexing first.
- Scene microbenchmarks isolate CPU preparation with GPU submission disabled after the real app has rendered. These numbers are **not GPU frame times or FPS claims**. Node animation itself remains approximately 0.6 ms in both versions.
- First-card insertion is navigation-to-DOM readiness, not a paint measurement. Cold shader/driver initialization creates substantial startup variance; the baseline p95 was 3,984 ms. Rendering now starts after the session list has a chance to paint.
- Browser preview measurements use an invented public API response. Database preparation is measured separately against real SQLite queries. They have different library sizes and should not be added together.
- SQLite schema v7 builds the message-time index once. Index construction and fixture creation are outside the per-preview measurements.
- These are local synthetic measurements, not production latency guarantees. Compare repeated runs on the same machine, without other builds or tests running.

## Navigation: orbit, pan, and zoom

The navigation benchmark submits real rendering work, using the same 2,400-session fixture, 1440 × 1000 viewport, balanced quality, and ANGLE Metal GPU. Three fresh browser runs each measure 120 frames per gesture after 30 warmup frames. GPU elapsed queries are collected asynchronously with `EXT_disjoint_timer_query_webgl2`; disjoint results are rejected. Summaries pool the measured frames across runs.

| Gesture | Before GPU median / p95 | After GPU median / p95 | Median reduction |
| --- | ---: | ---: | ---: |
| Orbit | 25.75 / 33.05 ms | 5.17 / 8.48 ms | 80% |
| Pan | 25.14 / 32.37 ms | 5.80 / 8.39 ms | 77% |
| Zoom | 25.10 / 32.24 ms | 5.75 / 8.54 ms | 77% |

Main-thread submission medians fell from 1.4–1.5 ms to 0.8–0.9 ms. Animation-frame interval p95 fell from about 33.4 ms to 16.7–16.8 ms. GPU elapsed time and headless animation-frame cadence are separate measurements; neither is a physical-display FPS guarantee.

The expensive work was fullscreen postprocessing, especially bloom. The new pipeline resolves geometry MSAA once into single-sample effect buffers and removes unnecessary canvas antialiasing and effect depth buffers. **Balanced mode temporarily defers bloom and SMAA while the camera moves**, retaining geometry MSAA, supersampling, and node halos. It restores those passes 150 ms after the last camera movement, including a final redraw when ambient motion is off. High quality, timeline playback, and manual video capture retain their configured effects.

Wheel zoom also exposed a correctness bug: OrbitControls changed the camera inside its event handler, but the subsequent `update()` returned false and the scene skipped drawing. The scene now tracks the controls' `change` event, refreshing the frame, camera-facing geometry, and picking together.

- The baseline is the original Git revision's `scene.ts` with the current surrounding app. Baseline zoom frames are explicitly invalidated so the timing comparison measures rendered zoom in both versions; a separate unforced probe records the original zero-draw bug. Optimized zoom uses normal invalidation.
- Every measured navigation frame must submit geometry. The benchmark cancels the app's automatic render loop and advances controls/rendering once per animation frame.
- `test:navigation` checks wheel redraws with damping on/off, idle refinement, quality changes, disabled bloom, and manual capture. Settled pixel comparisons against the original pipeline have mean RGB channel error below 0.001 on a 0–255 scale across all three quality settings.
- The renderer is now 3D-only following integration with `main`; the benchmark exercises orbit, pan, and zoom.

## Repeat the measurements

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium

# Original frontend source is loaded from Git during the benchmark build.
# The current checkout and saved session history are never replaced.
PERF_BASELINE=0f1de0115d203dec40dc9e4643989407047ea804 \
  pnpm benchmark:rendering tmp/performance/rendering-before.json
pnpm benchmark:rendering tmp/performance/rendering-after.json

# Original preparation code and pre-index schema, in a synthetic database.
PERF_BASELINE=0f1de0115d203dec40dc9e4643989407047ea804 \
  pnpm benchmark:publishing tmp/performance/publishing-before.json
pnpm benchmark:publishing tmp/performance/publishing-after.json

# Actual navigation with GPU submission and asynchronous GPU timing.
PERF_SCENE=0f1de0115d203dec40dc9e4643989407047ea804 \
  pnpm benchmark:navigation tmp/performance/navigation-before.json
pnpm benchmark:navigation tmp/performance/navigation-after.json

# Browser correctness checks plus the benchmark.
pnpm test:rendering
pnpm test:navigation
```

`PERF_RUNS` and `PERF_PER_LANE` control browser repetitions and session counts (six lanes). `PERF_SESSIONS` and `PERF_EVENTS` control the SQLite fixture. On macOS the runner explicitly uses Metal; other platforms record their chosen renderer in the output.

Navigation additionally accepts `PERF_FRAMES`, `PERF_QUALITY`, and `PERF_MOTION`. `PERF_BREAKDOWN=1` compares normal navigation, forced full effects, and individually disabled effects; `PERF_VARIANTS` selects a comma-separated subset. Diagnostic variants override adaptive effects only in the benchmark.

The runner builds production assets without the local API plugin. Every API request is intercepted with synthetic data. The scene hook exists only in this benchmark build. Browser tests cover measured row heights, viewport coverage, keyboard navigation beyond the original first page, focus retention, density changes, resize/hide/show, empty filters, 3D picking, geometry invalidation, preview context reuse, and renderer disposal.

## Implementation

- `packages/core/src/virtual-list.ts`: shared variable-height virtual list for the local sidebar and public viewer; logarithmic offset lookup and height updates, bounded DOM, keyed measurement reuse, scroll anchoring, and retained keyboard focus.
- `src/search/ui.ts`: reuse visible results, coalesce scrolling to animation frames, and reuse the date formatter.
- `src/main.ts`: paint sessions before graphics initialization; fit the camera without rebuilding the graph and list.
- `packages/core/src/scene.ts`: update transforms only when their inputs change; derive picking coordinates from the drawn instance matrices.
- `packages/core/src/scene-render-pass.ts` / `packages/core/src/scene.ts`: isolate geometry MSAA, retain immediate control changes, and refine balanced navigation after settling.
- `server/event-store.ts` / `server/store.ts`: additive partial index for conversation counts and ordered timestamps, with migration coverage.
- `server/publishing.ts`: reuse metadata queries, combine coverage reads, and stop fetching timestamps once the budget is exhausted.
- `src/publishing.ts` / `packages/core/src/public-viewer.ts`: update the existing preview renderer and virtualized session list, and cancel superseded preview requests.

Timing thresholds are deliberately kept out of unit tests. Structural assertions catch regressions reliably; use repeated benchmark comparisons to evaluate latency changes.
