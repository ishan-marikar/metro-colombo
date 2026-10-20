import { describe, expect, it } from "vitest";
import {
  nearestStop,
  parseNominatim,
  parsePhoton,
  walkMeters,
} from "../src/lib/geocode";
import type { CatalogStop } from "../src/types";

const feature = (props: object, coordinates = [80.37, 7.47]) => ({
  geometry: { coordinates },
  properties: { osm_type: "N", osm_id: 1, countrycode: "LK", ...props },
});

describe("parsePhoton", () => {
  it("keeps Sri Lankan named places and builds a short detail line", () => {
    const [place] = parsePhoton({
      features: [
        feature({ name: "Kuliyapitiya", city: "Kuliyapitiya", state: "NWP" }),
      ],
    });
    expect(place).toMatchObject({
      name: "Kuliyapitiya",
      detail: "NWP",
      latitude: 7.47,
      longitude: 80.37,
    });
  });

  it("drops other countries, unnamed and duplicate results", () => {
    const places = parsePhoton({
      features: [
        feature({ name: "Abroad", countrycode: "IN" }),
        feature({ name: undefined }),
        feature({ name: "Twice" }),
        feature({ name: "Twice" }),
        feature({ name: "Bokundara", state: "WP", osm_id: 2 }, [79.91, 6.81]),
        feature({ name: "bokundara", state: "WP", osm_id: 3 }, [79.92, 6.82]),
      ],
    });
    expect(places.map((place) => place.name)).toEqual(["Twice", "Bokundara"]);
  });

  it("tolerates junk", () => {
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ features: "no" })).toEqual([]);
  });
});

describe("nearestStop", () => {
  const stop = (id: string, latitude: number, longitude: number) =>
    ({ id, latitude, longitude }) as CatalogStop;

  it("picks the closest stop", () => {
    const result = nearestStop({ latitude: 6.93, longitude: 79.85 }, [
      stop("far", 7.2, 80.1),
      stop("near", 6.931, 79.851),
    ]);
    expect(result?.stop.id).toBe("near");
    expect(result?.meters).toBeLessThan(200);
  });

  it("returns null with no stops", () => {
    expect(nearestStop({ latitude: 0, longitude: 0 }, [])).toBeNull();
  });
});

describe("walkMeters", () => {
  it("pads the straight line and rounds to ten metres", () => {
    expect(walkMeters(500)).toBe(650);
  });
});

describe("parseNominatim", () => {
  const item = (extra: object) => ({
    osm_type: "node",
    osm_id: 1,
    lat: "6.8185",
    lon: "79.9178",
    name: "Bokundara",
    address: { village: "Bokundara", state_district: "Colombo District" },
    ...extra,
  });

  it("reads name, position and area", () => {
    expect(parseNominatim([item({})])).toEqual([
      {
        key: "found-node1",
        name: "Bokundara",
        detail: "Colombo District",
        latitude: 6.8185,
        longitude: 79.9178,
      },
    ]);
  });

  it("drops unnamed, unplaced and repeated entries", () => {
    const places = parseNominatim([
      item({}),
      item({ osm_id: 2 }),
      item({ osm_id: 3, name: "", address: {} }),
      item({ osm_id: 4, lat: "x" }),
    ]);
    expect(places).toHaveLength(1);
  });

  it("tolerates junk", () => {
    expect(parseNominatim({})).toEqual([]);
  });
});
