import { distanceMeters } from "../api";
import type { CatalogStop } from "../types";

export interface FoundPlace {
  key: string;
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api/";
// West, south, east, north: keeps results inside Sri Lanka.
const SRI_LANKA_BOUNDS = "79.4,5.8,82.0,9.95";
// Straight-line distance undercounts what you actually walk.
const WALK_DETOUR = 1.3;

/** A place the user picked; the trip starts or ends at its nearest stop. */
export interface Via {
  /** Null for a tapped spot, so the label follows the language. */
  name: string | null;
  /** The stop this was worked out for; the note is stale once the stop changes. */
  stopId?: string;
  walk: number;
  latitude?: number;
  longitude?: number;
}

export const MIN_QUERY_LENGTH = 3;
// The network covers Colombo, so a spot far from every stop isn't a walk.
export const MAX_WALK_TO_STOP_METERS = 5000;

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    name?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    countrycode?: string;
  };
}

export function parsePhoton(body: unknown): FoundPlace[] {
  const features = (body as { features?: PhotonFeature[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const seen = new Set<string>();
  return features.flatMap((feature) => {
    const props = feature.properties;
    const coords = feature.geometry?.coordinates;
    if (!props?.name || !coords || props.countrycode !== "LK") return [];
    const [longitude, latitude] = coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    const detail = [
      props.street,
      props.district,
      props.city,
      props.county,
      props.state,
    ]
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .filter((part) => part !== props.name)
      .slice(0, 3)
      .join(", ");
    const key = `found-${props.osm_type ?? ""}${props.osm_id ?? `${latitude},${longitude}`}`;
    // OpenStreetMap often holds one place as several entries; keep the best-ranked.
    const same = `${props.name}|${detail}`.toLocaleLowerCase();
    if (seen.has(key) || seen.has(same)) return [];
    seen.add(key);
    seen.add(same);
    return [{ key, name: props.name, detail, latitude, longitude }];
  });
}

interface NominatimResult {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  address?: Record<string, string>;
}

export function parseNominatim(body: unknown): FoundPlace[] {
  if (!Array.isArray(body)) return [];
  const seen = new Set<string>();
  return (body as NominatimResult[]).flatMap((item) => {
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    const address = item.address ?? {};
    const name = item.name || address.road;
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude))
      return [];
    const detail = [
      address.suburb,
      address.village ?? address.town ?? address.city,
      address.state_district,
    ]
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .filter((part) => part !== name)
      .slice(0, 2)
      .join(", ");
    const key = `found-${item.osm_type ?? ""}${item.osm_id ?? `${latitude},${longitude}`}`;
    const same = `${name}|${detail}`.toLocaleLowerCase();
    if (seen.has(key) || seen.has(same)) return [];
    seen.add(key);
    seen.add(same);
    return [{ key, name, detail, latitude, longitude }];
  });
}

async function searchNominatim(query: string, signal?: AbortSignal) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "lk");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "8");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`place search failed: ${response.status}`);
  return parseNominatim(await response.json());
}

async function searchPhoton(query: string, signal?: AbortSignal) {
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");
  url.searchParams.set("bbox", SRI_LANKA_BOUNDS);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`place search failed: ${response.status}`);
  return parsePhoton(await response.json());
}

const cache = new Map<string, FoundPlace[]>();

/** Nominatim answers in about a second; Photon is only the fallback because it can take ten. */
export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
): Promise<FoundPlace[]> {
  const key = query.toLocaleLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  let places: FoundPlace[];
  try {
    places = await searchNominatim(query, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    places = await searchPhoton(query, signal);
  }
  cache.set(key, places);
  return places;
}

export function nearestStop(
  point: Pick<FoundPlace, "latitude" | "longitude">,
  stops: readonly CatalogStop[],
): { stop: CatalogStop; meters: number } | null {
  let best: { stop: CatalogStop; meters: number } | null = null;
  for (const stop of stops) {
    const meters = distanceMeters(point, stop);
    if (!best || meters < best.meters) best = { stop, meters };
  }
  return best;
}

export function nearestStops(
  point: Pick<FoundPlace, "latitude" | "longitude">,
  stops: readonly CatalogStop[],
  count: number,
): { stop: CatalogStop; meters: number }[] {
  return stops
    .map((stop) => ({ stop, meters: distanceMeters(point, stop) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, count);
}

export function walkMeters(straightLine: number): number {
  return Math.round((straightLine * WALK_DETOUR) / 10) * 10;
}
