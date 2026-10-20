import { useEffect, useState } from "react";
import {
  MIN_QUERY_LENGTH,
  searchPlaces,
  type FoundPlace,
} from "../lib/geocode";

// Nominatim asks for at most one request a second, so wait for typing to pause.
const DEBOUNCE_MS = 600;

type Found = { query: string; places: FoundPlace[] };

/** Looks up what was typed once typing pauses; failures just mean no results. */
export function usePlaceSearch(query: string): {
  places: FoundPlace[];
  searching: boolean;
} {
  const [found, setFound] = useState<Found>({ query: "", places: [] });
  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(query, controller.signal).then(
        (places) => setFound({ query, places }),
        () => {
          if (!controller.signal.aborted) setFound({ query, places: [] });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const settled = found.query === query;
  return {
    places: settled ? found.places : [],
    searching: query.length >= MIN_QUERY_LENGTH && !settled,
  };
}
