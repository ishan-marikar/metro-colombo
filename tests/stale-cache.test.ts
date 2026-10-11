import assert from "node:assert/strict";
import { test } from "node:test";
import { Duration, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { staleCache, UpstreamError } from "../src/upstream.js";

test("serves the last good value when revalidation fails, then degrades past the stale window", async () => {
  const program = Effect.gen(function* () {
    let upstreamOk = true;
    let calls = 0;
    const get = yield* staleCache(
      (key: string) =>
        Effect.gen(function* () {
          calls += 1;
          if (!upstreamOk) {
            return yield* Effect.fail(
              new UpstreamError({ message: "upstream down" }),
            );
          }
          return `v${calls}:${key}`;
        }),
      {
        freshTtl: Duration.minutes(10),
        staleTtl: Duration.minutes(30),
        capacity: 4,
      },
    );

    assert.equal(yield* get("a"), "v1:a");
    assert.equal(yield* get("a"), "v1:a"); // cache hit
    assert.equal(calls, 1);

    upstreamOk = false;
    yield* TestClock.adjust(Duration.minutes(20)); // past fresh, within stale

    // The last good value is served at once; the refresh runs behind it and
    // fails.
    assert.equal(yield* get("a"), "v1:a");
    yield* Effect.yieldNow;
    assert.equal(calls, 2);

    yield* TestClock.adjust(Duration.minutes(20)); // 40 min total: past stale

    const result = yield* Effect.exit(get("a"));
    assert.ok(Exit.isFailure(result));
  });

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});

test("serves each key independently and evicts the least recently refreshed", async () => {
  const program = Effect.gen(function* () {
    let upstreamOk = true;
    const get = yield* staleCache(
      (key: string) =>
        upstreamOk
          ? Effect.succeed(`value-${key}`)
          : Effect.fail(new UpstreamError({ message: "upstream down" })),
      {
        freshTtl: Duration.minutes(10),
        staleTtl: Duration.minutes(30),
        capacity: 2,
      },
    );

    assert.equal(yield* get("a"), "value-a");
    assert.equal(yield* get("b"), "value-b");
    assert.equal(yield* get("c"), "value-c"); // evicts "a"

    upstreamOk = false;
    yield* TestClock.adjust(Duration.minutes(15)); // past fresh, within stale

    assert.equal(yield* get("c"), "value-c");
    assert.ok(
      Exit.isFailure(yield* Effect.exit(get("a"))),
      "evicted keys have no stale value",
    );
  });

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});

test("answers stale requests at once and refreshes once in the background", async () => {
  const program = Effect.gen(function* () {
    let calls = 0;
    const get = yield* staleCache(
      (key: string) =>
        Effect.gen(function* () {
          calls += 1;
          // A slow origin: only the first lookup is waited on.
          if (calls > 1) yield* Effect.sleep(Duration.seconds(10));
          return `v${calls}:${key}`;
        }),
      {
        freshTtl: Duration.minutes(10),
        staleTtl: Duration.minutes(30),
        capacity: 4,
      },
    );

    assert.equal(yield* get("a"), "v1:a");
    yield* TestClock.adjust(Duration.minutes(11)); // past fresh

    // Several requests during the slow refresh all get the old value now,
    // and start only one refresh between them.
    assert.equal(yield* get("a"), "v1:a");
    assert.equal(yield* get("a"), "v1:a");
    yield* Effect.yieldNow;
    assert.equal(calls, 2);

    yield* TestClock.adjust(Duration.seconds(10)); // the refresh lands
    yield* Effect.yieldNow;
    assert.equal(yield* get("a"), "v2:a");
    assert.equal(calls, 2);
  });

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});

test("waits for the origin when there is nothing usable to serve", async () => {
  const program = Effect.gen(function* () {
    let calls = 0;
    const get = yield* staleCache(
      (key: string) =>
        Effect.sync(() => {
          calls += 1;
          return `v${calls}:${key}`;
        }),
      {
        freshTtl: Duration.minutes(10),
        staleTtl: Duration.minutes(30),
        capacity: 4,
      },
    );

    assert.equal(yield* get("a"), "v1:a");
    yield* TestClock.adjust(Duration.minutes(31)); // past stale
    assert.equal(yield* get("a"), "v2:a"); // fetched while waiting, not served old
  });

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});

test("past serveStaleFor, waits for a fresh value and falls back to the old one only on failure", async () => {
  const program = Effect.gen(function* () {
    let upstreamOk = true;
    let calls = 0;
    const get = yield* staleCache(
      (key: string) =>
        Effect.gen(function* () {
          calls += 1;
          if (!upstreamOk) {
            return yield* Effect.fail(
              new UpstreamError({ message: "upstream down" }),
            );
          }
          return `v${calls}:${key}`;
        }),
      {
        freshTtl: Duration.minutes(1),
        serveStaleFor: Duration.minutes(2),
        staleTtl: Duration.minutes(10),
        capacity: 4,
      },
    );

    assert.equal(yield* get("a"), "v1:a");
    yield* TestClock.adjust(Duration.seconds(90)); // within serveStaleFor
    assert.equal(yield* get("a"), "v1:a"); // answered at once
    yield* Effect.yieldNow;
    assert.equal(calls, 2); // refreshed behind it

    yield* TestClock.adjust(Duration.minutes(3)); // past serveStaleFor
    assert.equal(yield* get("a"), "v3:a"); // waited for the origin

    upstreamOk = false;
    yield* TestClock.adjust(Duration.minutes(3)); // past serveStaleFor again
    assert.equal(yield* get("a"), "v3:a"); // origin down: old value stands in

    yield* TestClock.adjust(Duration.minutes(8)); // past staleTtl
    assert.ok(Exit.isFailure(yield* Effect.exit(get("a"))));
  });

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});
