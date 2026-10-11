// Upstream clients for the MetroBus backend (metrobusapiprod.eimsky.com) and
// lankametro.lk, exposed as an Effect service with stale-on-error caching.

import {
  Cache,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Auth } from "./auth.js";
import { UpstreamConfig } from "./config.js";
import * as S from "./schemas.js";

export class UpstreamError extends Schema.TaggedError<UpstreamError>()(
  "UpstreamError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    /** The upstream's own explanation of a rejected request. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const UpstreamErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});

const EimskyRoutesResponse = Schema.Struct({
  data: Schema.Struct({ routes: Schema.Array(S.Route) }),
});

const LkRoutesResponse = Schema.Struct({
  routes: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      color_hex: Schema.String,
    }),
  ),
});

const StopsResponse = Schema.Struct({
  data: Schema.Struct({ stops: Schema.Array(S.Stop) }),
});

const JourneyResponse = Schema.Struct({ data: S.JourneyPlan });

const REQUEST_TIMEOUT = Duration.seconds(15);
const FAILURE_RETRY_AFTER = Duration.seconds(2);

// lankametro.lk numbers its stops itself. `/api/stops` maps those numbers to
// the MetroBus stop code and id used everywhere else.
const LkPlacesResponse = Schema.Struct({
  places: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      name_si: Schema.String,
      name_ta: Schema.String,
      category: Schema.String,
      nearest_stop_id: Schema.Number,
      walk_meters: Schema.Number,
    }),
  ),
});
type LkPlace = (typeof LkPlacesResponse.Type)["places"][number];

const LkStopsResponse = Schema.Struct({
  stops: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      stop_code: Schema.String,
      eimsky_id: Schema.String,
    }),
  ),
});
type LkStop = (typeof LkStopsResponse.Type)["stops"][number];

/** Attaches each place's nearest stop. Places whose stop is unknown are dropped. */
export function linkPlaces(
  places: ReadonlyArray<LkPlace>,
  stops: ReadonlyArray<LkStop>,
): ReadonlyArray<S.Place> {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  return places.flatMap(({ nearest_stop_id, ...place }) => {
    const stop = byId.get(nearest_stop_id);
    return stop
      ? [
          {
            ...place,
            name: place.name.trim(),
            stop_code: stop.stop_code,
            stop_id: stop.eimsky_id,
          },
        ]
      : [];
  });
}

// Successful lookups are kept for `freshTtl`, so a healthy origin is barely
// bothered. After that the last good value is still answered straight away
// while a single background refresh fetches a new one, so no request waits
// on the origin for data it has seen before. Past `serveStaleFor` (default
// `staleTtl`), requests wait for a fresh value, and get the last good one
// only if the origin fails. Past `staleTtl` without a successful refresh,
// requests wait for the origin again and fail with it. Failures are retried
// after 2s.
export const staleCache = Effect.fnUntraced(function* <A>(
  lookup: (key: string) => Effect.Effect<A, UpstreamError>,
  options: {
    readonly freshTtl: Duration.Input;
    readonly staleTtl: Duration.Input;
    readonly serveStaleFor?: Duration.Input;
    readonly capacity: number;
  },
) {
  // Shares in-flight lookups, and holds a failure for 2s so a struggling
  // origin isn't hammered.
  const cache = yield* Cache.makeWith(lookup, {
    capacity: options.capacity,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? options.freshTtl : FAILURE_RETRY_AFTER,
  });
  const freshMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options.freshTtl),
  );
  const staleMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options.staleTtl),
  );
  const serveStaleMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options.serveStaleFor ?? options.staleTtl),
  );
  // Insertion-ordered. First key is the least recently refreshed.
  const lastGood = new Map<
    string,
    { readonly value: A; readonly at: number }
  >();
  const refreshing = new Set<string>();

  const remember = (key: string, value: A, at: number) => {
    lastGood.delete(key);
    lastGood.set(key, { value, at });
    if (lastGood.size > options.capacity) {
      lastGood.delete(lastGood.keys().next().value!);
    }
  };

  const fetch = (key: string) =>
    Effect.gen(function* () {
      const value = yield* Cache.get(cache, key);
      const now = yield* Clock.currentTimeMillis;
      if (lastGood.get(key)?.value !== value) remember(key, value, now);
      return value;
    });

  return (key: string): Effect.Effect<A, UpstreamError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = lastGood.get(key);
      if (!previous || now - previous.at > staleMillis)
        return yield* fetch(key);
      if (now - previous.at > serveStaleMillis) {
        const result = yield* Effect.exit(fetch(key));
        return Exit.isSuccess(result) ? result.value : previous.value;
      }
      if (now - previous.at >= freshMillis && !refreshing.has(key)) {
        refreshing.add(key);
        yield* fetch(key).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => refreshing.delete(key))),
          Effect.forkDetach,
        );
      }
      return previous.value;
    });
});

export class UpstreamApi extends Context.Service<
  UpstreamApi,
  {
    readonly routes: Effect.Effect<ReadonlyArray<S.Route>, UpstreamError>;
    readonly stopsFor: (
      routeId: string,
      directionId: string,
    ) => Effect.Effect<ReadonlyArray<S.Stop>, UpstreamError>;
    /** Every stop on every route direction, keyed by `stop_code`. */
    readonly stopIdsByCode: Effect.Effect<
      ReadonlyMap<string, string>,
      UpstreamError
    >;
    readonly journey: (
      fromStopId: string,
      toStopId: string,
      date: string,
    ) => Effect.Effect<S.JourneyPlan, UpstreamError>;
    readonly places: Effect.Effect<ReadonlyArray<S.Place>, UpstreamError>;
    readonly geometry: (
      geojsonUrl: string,
    ) => Effect.Effect<unknown, UpstreamError>;
  }
>()("lmt-go/UpstreamApi") {
  static readonly layer = Layer.effect(
    UpstreamApi,
    Effect.gen(function* () {
      const config = yield* UpstreamConfig;
      const http = yield* HttpClient.HttpClient;
      const auth = yield* Auth;
      const fareApi = `${config.eimskyBase}/fare-service/api/v1`;

      const getJson = <A>(
        schema: Schema.Codec<A, unknown>,
        url: string,
        headers: Record<string, string> = {},
      ): Effect.Effect<A, UpstreamError> =>
        Effect.gen(function* () {
          const response = yield* http.get(url, { headers });
          const ok = response.status >= 200 && response.status < 300;
          if (!ok) {
            const detail = yield* HttpClientResponse.schemaBodyJson(
              UpstreamErrorBody,
            )(response).pipe(
              Effect.map((body) => body.error.message),
              Effect.orElseSucceed(() => undefined),
            );
            return yield* new UpstreamError({
              message: `Upstream responded with HTTP ${response.status}`,
              status: response.status,
              detail,
            });
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(response);
        }).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) =>
            cause instanceof UpstreamError
              ? cause
              : new UpstreamError({
                  message: "Upstream request failed",
                  cause,
                }),
          ),
        );

      // Same as getJson but attaches the current auto-renewed bearer token.
      const getAuthed = <A>(schema: Schema.Codec<A, unknown>, url: string) =>
        Effect.gen(function* () {
          const token = yield* auth.currentToken.pipe(
            Effect.mapError(
              (error) =>
                new UpstreamError({
                  message: error.message,
                  status: 502,
                  cause: error,
                }),
            ),
          );
          return yield* getJson(schema, url, {
            authorization: `Bearer ${Redacted.value(token)}`,
          });
        });

      const fetchRoutes = Effect.gen(function* () {
        const [eimsky, lk] = yield* Effect.all(
          [
            getAuthed(EimskyRoutesResponse, `${fareApi}/routes/geo`),
            getJson(
              LkRoutesResponse,
              `${config.lankametroBase}/api/routes`,
            ).pipe(
              Effect.map((r) => r.routes),
              Effect.orElseSucceed(() => []),
            ),
          ],
          { concurrency: 2 },
        );
        const byCode = new Map(lk.map((route) => [route.code, route]));
        return eimsky.data.routes.map((route) => ({
          ...route,
          color_hex: byCode.get(route.code)?.color_hex,
        }));
      });

      const fetchStops = (routeId: string, directionId: string) =>
        getAuthed(
          StopsResponse,
          `${fareApi}/routes/${encodeURIComponent(routeId)}/stops?${new URLSearchParams({ direction_id: directionId })}`,
        ).pipe(
          // Upstream names often arrive with stray spaces and newlines attached.
          Effect.map((r) =>
            r.data.stops.map((stop) => ({
              ...stop,
              stop_name_en: stop.stop_name_en.trim(),
              stop_name_si: stop.stop_name_si.trim(),
              stop_name_tm: stop.stop_name_tm.trim(),
            })),
          ),
        );

      const fetchJourney = (from: string, to: string, date: string) =>
        getAuthed(
          JourneyResponse,
          `${fareApi}/journeys/plan?${new URLSearchParams({ from_stop_id: from, to_stop_id: to, date })}`,
        ).pipe(
          // `option_token` is for booking, which this API does not offer.
          Effect.map(({ data }) => ({
            ...data,
            options: data.options.map(
              ({ option_token: _, ...option }) => option,
            ),
          })),
        );

      const fetchPlaces = Effect.all(
        [
          getJson(LkPlacesResponse, `${config.lankametroBase}/api/places`),
          getJson(LkStopsResponse, `${config.lankametroBase}/api/stops`),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([places, stops]) => linkPlaces(places.places, stops.stops)),
      );

      // Route GeoJSON lives on Google Cloud Storage and lankametro.lk proxies the
      // same objects (by their already-encoded path) when direct access fails.
      // Only GCS URLs are fetched, whatever the upstream route data says.
      const GCS = "https://storage.googleapis.com/";
      const fetchGeometry = (url: string) =>
        url.startsWith(GCS)
          ? getJson(Schema.Unknown, url).pipe(
              Effect.catch(() =>
                getJson(
                  Schema.Unknown,
                  `${config.lankametroBase}/gcs-proxy/${url.slice(GCS.length)}`,
                ),
              ),
            )
          : Effect.fail(
              new UpstreamError({ message: `unexpected geometry URL: ${url}` }),
            );

      // Reference data is cached for hours and served stale for days, so the
      // API rides out an upstream outage. Journeys change by the minute, so
      // they stay short-lived.
      const routes = yield* staleCache(() => fetchRoutes, {
        freshTtl: Duration.hours(12),
        staleTtl: Duration.days(7),
        capacity: 1,
      });
      const stops = yield* staleCache(
        (key) => {
          const [routeId, directionId] = key.split("|");
          return fetchStops(routeId, directionId);
        },
        {
          freshTtl: Duration.hours(12),
          staleTtl: Duration.days(7),
          capacity: 64,
        },
      );
      const journey = yield* staleCache(
        (key) => {
          const [from, to, date] = key.split("|");
          return fetchJourney(from, to, date);
        },
        {
          freshTtl: Duration.seconds(60),
          // Today's plans carry live estimates, so only a plan a couple of
          // minutes old is answered without waiting. Older ones stand in
          // only while the origin is failing.
          serveStaleFor: Duration.minutes(2),
          staleTtl: Duration.minutes(10),
          capacity: 128,
        },
      );
      const places = yield* staleCache(() => fetchPlaces, {
        freshTtl: Duration.hours(24),
        staleTtl: Duration.days(7),
        capacity: 1,
      });
      const geometry = yield* staleCache(fetchGeometry, {
        freshTtl: Duration.hours(24),
        staleTtl: Duration.days(30),
        capacity: 32,
      });

      const stopsFor = (routeId: string, directionId: string) =>
        stops(`${routeId}|${directionId}`);

      // Built from the caches on each call, so a stop list that failed to load
      // earlier is picked up once it succeeds.
      const stopIdsByCode = Effect.gen(function* () {
        const directions = (yield* routes("all")).flatMap((route) =>
          route.directions.map((direction) => ({ route, direction })),
        );
        const lists = yield* Effect.forEach(
          directions,
          ({ route, direction }) =>
            stopsFor(route.id, direction.id).pipe(
              Effect.orElseSucceed((): ReadonlyArray<S.Stop> => []),
            ),
          { concurrency: 8 },
        );
        return new Map(lists.flat().map((stop) => [stop.stop_code, stop.id]));
      });

      return UpstreamApi.of({
        routes: routes("all"),
        stopsFor,
        stopIdsByCode,
        journey: (from, to, date) => journey(`${from}|${to}|${date}`),
        places: places("all"),
        geometry,
      });
    }),
  );
}
