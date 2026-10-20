import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as LibreMap,
} from "maplibre-gl";
import type {
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  Point,
  Position,
} from "geojson";
import { AlertTriangle, MapPin } from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { i18n } from "../i18n";
import { MAP_STATUS } from "../classNames";
import { dragDistance, type FollowEvent } from "../lib/follow";
import {
  BUILDING_HEIGHT_SCALE,
  BUILDINGS_FULL_ZOOM,
  BUILDINGS_MIN_ZOOM,
  ISOMETRIC_FOV,
  MAP_MODE_KEY,
  canShowBuildings,
  initialTilt,
  parseMapMode,
  pitchForZoom,
  tiltFor,
  zoomBand,
  type DeviceFacts,
  type MapMode,
  type TiltState,
} from "../lib/mapCamera";
import { routeColor as colorForRoute } from "../lib/routeColor";
import { splitRoute } from "../lib/routeSplit";
import type { BusLine } from "../state/useBusJourney";
import { palette } from "../theme";
import { parseCrowdingPreview } from "../lib/busBounce";
import { BusModelLayer } from "./BusModelLayer";
import {
  addFestiveLayers,
  useFestiveMap,
  type FestiveMap,
  type Road,
} from "./festiveMap";
import { StandModelLayer } from "./StandModelLayer";
import { DriveControl } from "./DriveControl";
import { MapModeControl } from "./MapModeControl";
import {
  CHASE_MAX_PITCH,
  CHASE_PITCH,
  CHASE_ZOOM,
  chaseBearing,
  chaseOffset,
} from "../lib/chaseCamera";
import { BASEMAP_STYLE } from "../lib/basemap";
import { Button } from "./ui/Button";
import { Notice } from "./ui/Notice";
import {
  busKey,
  stopName,
  type MapViewProps,
  type Ride,
  type RouteRef,
  type Stop,
} from "../types";

const COLOMBO: [number, number] = [79.8612, 6.9271];
const ROUTES = "metro-routes";
const SPLIT = "metro-route-split";
const STOPS = "metro-stops";
const STOP_HIT = "metro-stop-hit";
const ROUTE_LINES = "metro-route-lines";
const BUILDINGS = "metro-buildings-3d";
const BASEMAP_BUILDINGS = "building";
const BUILDINGS_OPACITY = 0.88;
const STOP_COLOR = palette.ink;
const WALK_COLOR = palette.muted;
const FOLLOW_FOCUS = "bus-follow";
const CAMERA_MS = 900;
const FOLLOW_MIN_ZOOM = 15;
// Basemap sources whose errors mean the tile provider couldn't be reached.
const TILE_SOURCES: unknown[] = ["openmaptiles", "ne2_shaded"];
type Line = LineString | MultiLineString;
type MapProperties = Record<string, string | number | boolean>;
type Lines = FeatureCollection<Line, MapProperties>;
type Points = FeatureCollection<Point, MapProperties>;
type Scene = {
  routes: Lines;
  stops: Points;
  stopLookup: Map<string, Stop>;
};
const NO_ROUTES: RouteRef[] = [];
type Warning = "tiles" | "map" | "location" | "permission" | null;

type Props = Omit<MapViewProps, "onFollowChange"> & {
  onFollowEvent: (event: FollowEvent) => void;
  frameRide?: Ride | null;
  busLine?: BusLine | null;
  festive?: FestiveMap | null;
  onCapabilities?: (rich: boolean) => void;
  pickMode?: boolean;
  onPickPoint?: (point: { latitude: number; longitude: number }) => void;
  pins?: {
    kind: "from" | "to" | "pending";
    latitude: number;
    longitude: number;
  }[];
};

type Insets = Props["insets"];

// Keeps fitted content clear of the caption, legend and control column, or
// on phones of the header, the drawer and the control column.
function viewportPadding(insets: Insets): maplibregl.PaddingOptions {
  if (!insets) return { top: 140, bottom: 110, left: 60, right: 80 };
  return {
    top: insets.top + 24,
    bottom: insets.bottom + 32,
    left: 40,
    right: 72,
  };
}

function followShift(insets: Insets): number {
  return insets ? (insets.bottom - insets.top) / 2 : 0;
}

function coordinatesValid(position: Position): boolean {
  return (
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    Math.abs(position[0]) <= 180 &&
    Math.abs(position[1]) <= 90
  );
}

function stopKey(stop: Stop): string {
  return `${stop.id}:${stop.longitude}:${stop.latitude}`;
}

function stopPosition(stop: Stop): Position {
  return [stop.longitude, stop.latitude];
}

function validStop(stop: Stop): boolean {
  return coordinatesValid(stopPosition(stop));
}

function directionsMatch(a?: string, b?: string): boolean {
  return !a || !b || a === b;
}

function hiddenByLock(
  route: MapViewProps["routes"][number],
  lock: RouteRef | null,
): boolean {
  return (
    lock !== null &&
    (route.code !== lock.routeCode ||
      !directionsMatch(lock.directionId, route.directionId))
  );
}

function lineCoordinates(geometry: Line): Position[] {
  return geometry.type === "LineString"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

function pointerPoint(
  event: Event | undefined,
): { x: number; y: number } | null {
  if (event instanceof MouseEvent)
    return { x: event.clientX, y: event.clientY };
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

function isMultiTouch(event: Event | undefined): boolean {
  return (
    typeof TouchEvent !== "undefined" &&
    event instanceof TouchEvent &&
    event.touches.length > 1
  );
}

function nearestStop(
  map: LibreMap,
  point: maplibregl.Point,
  lookup: Map<string, Stop>,
): Stop | undefined {
  const features = map.queryRenderedFeatures(point, { layers: [STOP_HIT] });
  let nearest: Stop | undefined;
  let distance = Infinity;
  for (const feature of features) {
    const stop = lookup.get(String(feature.properties?.key));
    if (!stop) continue;
    const projected = map.project([stop.longitude, stop.latitude]);
    const candidate = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (candidate < distance) {
      nearest = stop;
      distance = candidate;
    }
  }
  return nearest;
}

function realLines(geometry: Geometry): Line[] {
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.flatMap(realLines);
  if (geometry.type === "LineString") {
    return geometry.coordinates.length >= 2 &&
      geometry.coordinates.every(coordinatesValid)
      ? [geometry]
      : [];
  }
  if (geometry.type === "MultiLineString") {
    const coordinates = geometry.coordinates.filter(
      (line) => line.length >= 2 && line.every(coordinatesValid),
    );
    return coordinates.length ? [{ type: "MultiLineString", coordinates }] : [];
  }
  return [];
}

type JourneyStopMark = {
  stop: Stop;
  board: boolean;
  alight: boolean;
  /** The route ridden to or from this stop; none for a walk. */
  routeCode?: string;
};

function journeyStops(
  journey: MapViewProps["selectedJourney"],
): JourneyStopMark[] {
  return (
    journey?.legs.flatMap((leg): JourneyStopMark[] => {
      if (leg.kind === "ride") {
        const routeCode = leg.ride.route.code;
        return [
          ...(leg.ride.stops ?? []).map((stop) => ({
            stop,
            board: false,
            alight: false,
            routeCode,
          })),
          { stop: leg.ride.board, board: true, alight: false, routeCode },
          { stop: leg.ride.alight, board: false, alight: true, routeCode },
        ];
      }
      return [leg.move.from_stop, leg.move.to_stop].map((stop) => ({
        stop,
        board: false,
        alight: false,
      }));
    }) ?? []
  );
}

function setScene(map: LibreMap, next: Scene, previous: Scene | null): void {
  if (next.routes !== previous?.routes)
    (map.getSource(ROUTES) as GeoJSONSource | undefined)?.setData(next.routes);
  if (next.stops !== previous?.stops)
    (map.getSource(STOPS) as GeoJSONSource | undefined)?.setData(next.stops);
}

function addTransitLayers(map: LibreMap): void {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource(ROUTES, { type: "geojson", data: empty });
  map.addSource(SPLIT, { type: "geojson", data: empty });
  // Stops are keyed so the one under the mouse can carry a hover state.
  map.addSource(STOPS, { type: "geojson", data: empty, promoteId: "key" });
  // Route lines go under the basemap's place labels; stops stay on top.
  const firstLabel = map
    .getStyle()
    .layers.find((layer) => layer.type === "symbol")?.id;
  map.addLayer(
    {
      id: ROUTE_LINES,
      type: "line",
      source: ROUTES,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["case", ["get", "highlight"], 6, 4],
        // The opened route stands out; the rest of the network steps back.
        "line-opacity": [
          "case",
          ["get", "hidden"],
          0,
          ["get", "dimmed"],
          0.2,
          ["get", "highlight"],
          1,
          0.75,
        ],
      },
    },
    firstLabel,
  );
  map.addLayer(
    {
      id: SPLIT,
      type: "line",
      source: SPLIT,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 6,
        "line-opacity": ["case", ["==", ["get", "phase"], "behind"], 0.25, 1],
        "line-opacity-transition": { duration: 0 },
      },
    },
    firstLabel,
  );
  // The selected stop's ink ring on a paper halo lets it read on any basemap and not by colour alone.
  const end: ExpressionSpecification = [
    "any",
    ["get", "board"],
    ["get", "alight"],
  ];
  const bySize = (
    selected: number,
    ends: number,
    journey: number,
    stop: number,
  ): ExpressionSpecification => [
    "case",
    ["get", "selected"],
    selected,
    end,
    ends,
    ["get", "journey"],
    journey,
    stop,
  ];
  const hovered: ExpressionSpecification = [
    "boolean",
    ["feature-state", "hover"],
    false,
  ];
  map.addLayer({
    id: "metro-stop-halo",
    type: "circle",
    source: STOPS,
    filter: ["get", "selected"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 15, 16, 22],
      "circle-color": palette.paper,
      "circle-opacity": 0.92,
      "circle-stroke-width": 3,
      "circle-stroke-color": palette.ink,
      "circle-pitch-alignment": "map",
    },
  });
  addFestiveLayers(map, "metro-stop-halo");
  map.addLayer({
    id: "metro-stop-dots",
    type: "circle",
    source: STOPS,
    layout: {
      "circle-sort-key": [
        "case",
        ["get", "selected"],
        3,
        end,
        2,
        ["get", "journey"],
        1,
        0,
      ],
    },
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        ["+", bySize(6, 5, 3, 2.5), ["case", hovered, 1.5, 0]],
        13,
        ["+", bySize(8, 7, 5, 4.5), ["case", hovered, 2, 0]],
        16,
        ["+", bySize(10, 9, 7, 7), ["case", hovered, 2, 0]],
      ],
      "circle-stroke-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        ["case", ["any", ["get", "selected"], end, hovered], 2, 1],
        14,
        ["case", ["any", ["get", "selected"], end, hovered], 3, 2],
      ],
      "circle-color": [
        "case",
        ["get", "selected"],
        ["get", "color"],
        "#ffffff",
      ],
      "circle-stroke-color": [
        "case",
        ["get", "selected"],
        "#ffffff",
        hovered,
        palette.ink,
        ["get", "color"],
      ],
      "circle-pitch-alignment": "map",
    },
  });
  // An invisible 44px target makes small stop dots usable without enlarging the visual clutter.
  map.addLayer({
    id: STOP_HIT,
    type: "circle",
    source: STOPS,
    paint: {
      "circle-radius": 22,
      "circle-color": "#ffffff",
      "circle-opacity": 0,
    },
  });
}

function controlLabels(): Record<string, string> {
  return {
    "NavigationControl.ZoomIn": t(i18n)`Zoom in`,
    "NavigationControl.ZoomOut": t(i18n)`Zoom out`,
    "NavigationControl.ResetBearing": t(i18n)`Point north`,
    "GeolocateControl.FindMyLocation": t(i18n)`Find my location`,
    "GeolocateControl.LocationNotAvailable": t(i18n)`Location unavailable`,
    "AttributionControl.ToggleAttribution": t(i18n)`Map credits`,
  };
}

function labelControls(map: LibreMap): void {
  const labels = controlLabels();
  const selectors: Record<string, string> = {
    ".maplibregl-ctrl-zoom-in": "NavigationControl.ZoomIn",
    ".maplibregl-ctrl-zoom-out": "NavigationControl.ZoomOut",
    ".maplibregl-ctrl-compass": "NavigationControl.ResetBearing",
    ".maplibregl-ctrl-geolocate": "GeolocateControl.FindMyLocation",
    ".maplibregl-ctrl-attrib-button": "AttributionControl.ToggleAttribution",
  };
  for (const [selector, key] of Object.entries(selectors)) {
    const button = map
      .getContainer()
      .querySelector<HTMLButtonElement>(selector);
    const label =
      labels[
        selector === ".maplibregl-ctrl-geolocate" && button?.disabled
          ? "GeolocateControl.LocationNotAvailable"
          : key
      ];
    button?.setAttribute("aria-label", label);
    button?.setAttribute("title", label);
  }
  map
    .getCanvas()
    .setAttribute(
      "aria-label",
      t(i18n)`Transit map. Use arrow keys to move and plus or minus to zoom.`,
    );
}

function storedMapMode(): MapMode {
  try {
    return parseMapMode(localStorage.getItem(MAP_MODE_KEY)) ?? "3d";
  } catch {
    return "3d";
  }
}

function storeMapMode(mode: MapMode): void {
  try {
    localStorage.setItem(MAP_MODE_KEY, mode);
  } catch {
    // The choice just isn't remembered.
  }
}

function deviceFacts(canvas: HTMLCanvasElement): DeviceFacts {
  const device = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  return {
    // A canvas hands back the context it already has only when the type matches.
    webgl2: canvas.getContext("webgl2") !== null,
    saveData: device.connection?.saveData,
    deviceMemory: device.deviceMemory,
  };
}

// Flat layers depth-test against the buildings, so clearing depth after them
// keeps route lines, stops and buses drawn over the buildings.
const depthReset: maplibregl.CustomLayerInterface = {
  id: "metro-depth-reset",
  type: "custom",
  renderingMode: "3d",
  render(gl) {
    gl.clear(gl.DEPTH_BUFFER_BIT);
  },
};

function addBuildings(map: LibreMap): boolean {
  if (!map.getLayer(BASEMAP_BUILDINGS) || !map.getSource("openmaptiles"))
    return false;
  const height = (property: string): ExpressionSpecification => [
    "interpolate",
    ["linear"],
    ["zoom"],
    BUILDINGS_MIN_ZOOM,
    0,
    BUILDINGS_FULL_ZOOM,
    ["*", BUILDING_HEIGHT_SCALE, ["coalesce", ["get", property], 0]],
  ];
  map.addLayer(
    {
      id: BUILDINGS,
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: BUILDINGS_MIN_ZOOM,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": palette.field,
        "fill-extrusion-height": height("render_height"),
        "fill-extrusion-base": height("render_min_height"),
        "fill-extrusion-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          BUILDINGS_MIN_ZOOM,
          0,
          BUILDINGS_FULL_ZOOM,
          BUILDINGS_OPACITY,
        ],
      },
    },
    ROUTE_LINES,
  );
  map.addLayer(depthReset, ROUTE_LINES);
  return true;
}

function showBuildings(map: LibreMap, show: boolean): void {
  if (!map.getLayer(BUILDINGS)) return;
  map.setLayoutProperty(BUILDINGS, "visibility", show ? "visible" : "none");
  map.setPaintProperty(
    BASEMAP_BUILDINGS,
    "fill-opacity",
    show
      ? [
          "interpolate",
          ["linear"],
          ["zoom"],
          BUILDINGS_MIN_ZOOM,
          1,
          BUILDINGS_FULL_ZOOM,
          0,
        ]
      : 1,
  );
}

function steerPitch(
  map: LibreMap,
  tilt: TiltState,
  pitch: number,
  options: maplibregl.EaseToOptions = {},
): void {
  tilt.directed = true;
  tilt.manualBand = null;
  tilt.blend = null;
  // MapLibre skips the animation when the user prefers reduced motion.
  map.easeTo(
    { duration: CAMERA_MS, ...options, pitch },
    { steeredPitch: true },
  );
}

const DEFAULT_MAX_PITCH = 60;

function driveLabels(driving: boolean): string {
  return driving ? t(i18n)`Leave driver view` : t(i18n)`Driver view`;
}

function mapModeLabels(mode: MapMode): { aria: string; title: string } {
  const label = mode === "3d" ? t(i18n)`Show flat map` : t(i18n)`Show 3D map`;
  return { aria: label, title: label };
}

const BUS_ICON_PATH =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 2 7"/><path d="M10 6h4"/><path d="m22 7-2-1"/><rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M8 15h.01"/><path d="M16 15h.01"/><path d="M6 19v2"/><path d="M18 21v-2"/></svg>';

function liveBusLabels(show: boolean): { aria: string; title: string } {
  const label = show ? t(i18n)`Hide live buses` : t(i18n)`Show live buses`;
  return { aria: label, title: label };
}

class LiveBusesControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(
    private show: boolean,
    private labels: (show: boolean) => { aria: string; title: string },
    private onToggle: () => void,
  ) {}

  onAdd(): HTMLElement {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "map-live-toggle-ctrl";
    this.button.innerHTML = BUS_ICON_PATH;
    this.button.addEventListener("click", this.onToggle);
    this.container.appendChild(this.button);
    this.update(this.show);
    return this.container;
  }

  onRemove(): void {
    this.button?.removeEventListener("click", this.onToggle);
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.button = null;
  }

  update(show: boolean): void {
    this.show = show;
    if (!this.button) return;
    const { aria, title } = this.labels(show);
    this.button.setAttribute("aria-pressed", String(show));
    this.button.setAttribute("aria-label", aria);
    this.button.setAttribute("title", title);
  }

  setLabels(labels: (show: boolean) => { aria: string; title: string }): void {
    this.labels = labels;
    this.update(this.show);
  }
}

export default function MapView(props: Props) {
  const {
    routes,
    routeCatalog,
    stops,
    buses,
    from,
    to,
    selectedStop,
    selectedJourney,
    selectedBus,
    followBus,
    frameRide = null,
    language,
    showLive,
    insets,
    routeLock = null,
    emphasizeRoutes = NO_ROUTES,
    busOverlay,
    busLine = null,
    festive = null,
  } = props;
  const { t } = useLingui();
  const selectedBusKey = selectedBus ? busKey(selectedBus) : "";
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const liveControlRef = useRef<LiveBusesControl | null>(null);
  const driveControlRef = useRef<DriveControl | null>(null);
  const modeControlRef = useRef<MapModeControl | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>(storedMapMode);
  const tilt = useRef<TiltState>(initialTilt(mapMode));
  const buildingsReady = useRef(false);
  const flatFov = useRef<number | null>(null);
  const shownMode = useRef<MapMode | null>(null);
  const busLayerRef = useRef<BusModelLayer | null>(null);
  const standLayerRef = useRef<StandModelLayer | null>(null);
  const ready = useRef(false);
  const appliedScene = useRef<Scene | null>(null);
  const appliedFocus = useRef<string | null>(null);
  const userMoved = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [warning, setWarning] = useState<Warning>(null);
  const [attempt, setAttempt] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  const busLat = selectedBus?.lat;
  const busLng = selectedBus?.lng;
  const busRouteCode = busLine?.routeCode;
  const busDirectionId = busLine?.directionId;
  const busSplit = useMemo(() => {
    if (busLat === undefined || busLng === undefined || !busDirectionId)
      return null;
    const route = routes.find(
      (item) =>
        item.code === busRouteCode && item.directionId === busDirectionId,
    );
    const split = route && splitRoute(route, { lat: busLat, lng: busLng });
    if (!route || !split) return null;
    const color = colorForRoute(route.color);
    const piece = (phase: string, lines: Position[][]) =>
      lines.map((coordinates) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates },
        properties: { phase, color },
      }));
    return {
      code: route.code,
      direction: route.directionId,
      data: {
        type: "FeatureCollection" as const,
        features: [
          ...piece("behind", split.behind),
          ...piece("ahead", split.ahead),
        ],
      },
    };
  }, [busLat, busLng, busRouteCode, busDirectionId, routes]);

  const selectedBusRoute = selectedBus?.route_code ?? "";
  const splitCode = busSplit?.code;
  const splitDirection = busSplit?.direction;
  const routeData = useMemo<Lines>(
    () => ({
      type: "FeatureCollection",
      features: routes.flatMap((route) => {
        if (hiddenByLock(route, routeLock)) return [];
        const highlight = emphasizeRoutes.some(
          (item) =>
            item.routeCode === route.code &&
            directionsMatch(item.directionId, route.directionId),
        );
        // A tracked bus quietens other routes too, without moving the camera
        // to its route the way an opened route does.
        const dimmed = emphasizeRoutes.length
          ? !emphasizeRoutes.some((item) => item.routeCode === route.code)
          : selectedBusRoute !== "" && route.code !== selectedBusRoute;
        return route.geometry.features.flatMap((feature) =>
          feature.geometry
            ? realLines(feature.geometry).map((geometry) => ({
                type: "Feature" as const,
                geometry,
                properties: {
                  code: route.code,
                  color: colorForRoute(route.color),
                  highlight,
                  dimmed,
                  hidden:
                    route.code === splitCode &&
                    route.directionId === splitDirection,
                },
              }))
            : [],
        );
      }),
    }),
    [
      routes,
      routeLock,
      emphasizeRoutes,
      selectedBusRoute,
      splitCode,
      splitDirection,
    ],
  );

  const stopScene = useMemo(() => {
    const lookup = new Map<string, Stop>();
    const properties = new Map<string, MapProperties>();
    const routeColor = (code: string | undefined) =>
      routes.find((route) => route.code === code)?.color;
    const baseColor = routeColor(emphasizeRoutes[0]?.routeCode) ?? STOP_COLOR;
    const add = (
      stop: Stop,
      journey = false,
      board = false,
      alight = false,
      color = baseColor,
    ) => {
      if (!validStop(stop)) return;
      const key = stopKey(stop);
      lookup.set(key, stop);
      const previous = properties.get(key);
      properties.set(key, {
        key,
        journey: journey || previous?.journey === true,
        board: board || previous?.board === true,
        alight: alight || previous?.alight === true,
        selected: Boolean(selectedStop && stopKey(selectedStop) === key),
        color: journey ? color : (previous?.color ?? color),
      });
    };
    stops.forEach((stop) => add(stop));
    journeyStops(selectedJourney).forEach((item) =>
      add(
        item.stop,
        true,
        item.board,
        item.alight,
        item.routeCode ? (routeColor(item.routeCode) ?? baseColor) : WALK_COLOR,
      ),
    );
    if (from) add(from);
    if (to) add(to);
    if (selectedStop) add(selectedStop);
    const data: Points = {
      type: "FeatureCollection",
      features: [...lookup].map(([key, stop]) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: stopPosition(stop),
        },
        properties: properties.get(key)!,
      })),
    };
    return { data, lookup };
  }, [stops, selectedStop, selectedJourney, from, to, routes, emphasizeRoutes]);

  const scene = useMemo<Scene>(
    () => ({
      routes: routeData,
      stops: stopScene.data,
      stopLookup: stopScene.lookup,
    }),
    [routeData, stopScene],
  );

  const following = followBus && selectedBusKey !== "";
  const [driving, setDriving] = useState(false);
  const isDriving = following && driving;
  useEffect(() => {
    if (!following) setDriving(false);
  }, [following]);
  useEffect(() => {
    driveControlRef.current?.update(following, isDriving);
  }, [following, isDriving, status]);
  const focus = useMemo(() => {
    if (following) return { coordinates: [], key: FOLLOW_FOCUS };
    let coordinates: Position[] = [];
    let kind = "route";
    if (selectedStop && validStop(selectedStop)) {
      kind = "stop";
      coordinates = [stopPosition(selectedStop)];
    } else if (frameRide) {
      kind = "ride";
      coordinates = [
        frameRide.board,
        ...(frameRide.stops ?? []),
        frameRide.alight,
      ]
        .filter(validStop)
        .map(stopPosition);
    } else if (selectedJourney) {
      kind = "journey";
      coordinates = journeyStops(selectedJourney)
        .filter((item) => validStop(item.stop))
        .map(({ stop }) => stopPosition(stop));
    } else if ((from && validStop(from)) || (to && validStop(to))) {
      kind = "endpoints";
      coordinates = [from, to]
        .filter((stop): stop is Stop => Boolean(stop && validStop(stop)))
        .map(stopPosition);
    } else {
      const shown = emphasizeRoutes.length
        ? routeData.features.filter((feature) => feature.properties.highlight)
        : routeData.features;
      coordinates = shown.flatMap((feature) =>
        lineCoordinates(feature.geometry),
      );
      coordinates.push(...stops.filter(validStop).map(stopPosition));
    }
    return {
      coordinates,
      key: `${kind}:${coordinates.map((position) => `${position[0]},${position[1]}`).join(";")}`,
    };
  }, [
    selectedStop,
    frameRide,
    selectedJourney,
    from,
    to,
    routeData,
    emphasizeRoutes,
    stops,
    following,
  ]);

  const latest = useRef({ props, scene, focus });
  useEffect(() => {
    latest.current = { props, scene, focus };
  }, [props, scene, focus]);

  const syncBuses = useCallback(() => {
    const { buses, showLive, routes, routeCatalog } = latest.current.props;
    busLayerRef.current?.setFixes(showLive ? buses : [], routes, routeCatalog);
  }, []);

  const applyFocus = useCallback((map: LibreMap, next: typeof focus): void => {
    if (appliedFocus.current === next.key) return;
    const firstView = appliedFocus.current === null;
    // Leaving follow mode keeps the camera where the user (or the bus) left it.
    const wasFollowing = appliedFocus.current === FOLLOW_FOCUS;
    appliedFocus.current = next.key;
    if (wasFollowing && !next.key.startsWith("ride:")) {
      // Otherwise the follow panel closing reframes the map to the whole network.
      userMoved.current = true;
      return;
    }
    if (next.coordinates.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    next.coordinates.forEach((position) =>
      bounds.extend([position[0], position[1]]),
    );
    const single = next.coordinates.length === 1;
    userMoved.current = false;
    map.fitBounds(bounds, {
      padding: viewportPadding(latest.current.props.insets),
      maxZoom: single ? 16 : 14,
      // MapLibre skips the animation when the user prefers reduced motion.
      duration: firstView ? 0 : CAMERA_MS,
    });
  }, []);

  useEffect(() => {
    if (!container.current) return;
    let map: LibreMap | undefined;
    let disposed = false;
    let failed = false;
    let observer: ResizeObserver | undefined;
    let resizeFrame: number | undefined;
    let canvas: HTMLCanvasElement | undefined;
    const markUnavailable = () => {
      failed = true;
      ready.current = false;
      setStatus("unavailable");
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) markUnavailable();
    };
    const resize = () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!disposed) map?.resize();
      });
    };
    setStatus("loading");
    setWarning(null);
    ready.current = false;
    appliedScene.current = null;
    appliedFocus.current = null;
    try {
      map = new maplibregl.Map({
        container: container.current,
        center: COLOMBO,
        zoom: 11,
        pitch: tilt.current.mode === "3d" ? pitchForZoom(11) : 0,
        bearing: 0,
        locale: controlLabels(),
        style: BASEMAP_STYLE,
        canvasContextAttributes: { antialias: true },
        transformCameraUpdate: ({ zoom, pitch }) => {
          const next = tiltFor(tilt.current, zoom, pitch);
          return next === undefined ? {} : { pitch: next };
        },
      });
      mapRef.current = map;
      const activeMap = map;
      flatFov.current = activeMap.getVerticalFieldOfView();
      shownMode.current = tilt.current.mode;
      if (tilt.current.mode === "3d")
        activeMap.setVerticalFieldOfView(ISOMETRIC_FOV);
      canvas = activeMap.getCanvas();
      canvas.addEventListener("webglcontextlost", contextLost);
      activeMap.addControl(
        new maplibregl.NavigationControl({ showCompass: true }),
        "top-right",
      );
      const geolocation = new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true, timeout: 12000 },
        trackUserLocation: true,
        showUserLocation: true,
        showAccuracyCircle: true,
        fitBoundsOptions: { maxZoom: 16, duration: CAMERA_MS },
      });
      activeMap.addControl(geolocation, "top-right");
      const modeControl = new MapModeControl(
        tilt.current.mode,
        mapModeLabels,
        () => {
          const mode = tilt.current.mode === "3d" ? "2d" : "3d";
          storeMapMode(mode);
          setMapMode(mode);
        },
      );
      modeControlRef.current = modeControl;
      activeMap.addControl(modeControl, "top-right");
      const liveControl = new LiveBusesControl(
        latest.current.props.showLive,
        liveBusLabels,
        () =>
          latest.current.props.onShowLiveChange(!latest.current.props.showLive),
      );
      liveControlRef.current = liveControl;
      activeMap.addControl(liveControl, "top-right");
      const driveControl = new DriveControl(driveLabels, () =>
        setDriving((current) => !current),
      );
      driveControlRef.current = driveControl;
      activeMap.addControl(driveControl, "top-right");
      geolocation.on("error", (event) => {
        if (!disposed) setWarning(event.code === 1 ? "permission" : "location");
      });
      geolocation.on("geolocate", () => {
        if (!disposed)
          setWarning((current) =>
            current === "permission" || current === "location" ? null : current,
          );
      });
      labelControls(activeMap);
      activeMap.on("pitchstart", (event) => {
        if (event.originalEvent && tilt.current.mode === "3d") {
          tilt.current.manualBand = zoomBand(activeMap.getZoom());
          tilt.current.blend = null;
        }
      });
      activeMap.on("moveend", (event) => {
        const state = tilt.current;
        if ("steeredPitch" in event) {
          state.directed = false;
          // At pitch 0 the field of view doesn't show, so it changes there.
          if (state.mode === "2d" && flatFov.current !== null)
            activeMap.setVerticalFieldOfView(flatFov.current);
        }
        if (state.directed || state.mode !== "3d" || !state.reducedMotion)
          return;
        if (state.manualBand !== null) return;
        const target = pitchForZoom(activeMap.getZoom());
        if (Math.abs(activeMap.getPitch() - target) > 0.1)
          steerPitch(activeMap, state, target, { duration: 0 });
      });
      // Pointing north also gives up a hand-set tilt.
      activeMap
        .getContainer()
        .querySelector(".maplibregl-ctrl-compass")
        ?.addEventListener("click", () => {
          const state = tilt.current;
          if (state.mode !== "3d") return;
          if (state.manualBand === null && state.blend === null) return;
          steerPitch(activeMap, state, pitchForZoom(activeMap.getZoom()), {
            bearing: 0,
          });
        });
      activeMap.on("movestart", (event) => {
        // Gestures carry the event that started them; our own camera moves don't.
        if ("originalEvent" in event && event.originalEvent)
          userMoved.current = true;
      });
      activeMap.on("error", (event) => {
        if (disposed) return;
        if (/webgl|context lost/i.test(event.error.message)) markUnavailable();
        else
          setWarning(
            "sourceId" in event && TILE_SOURCES.includes(event.sourceId)
              ? "tiles"
              : "map",
          );
      });
      activeMap.on("load", () => {
        if (disposed || failed) return;
        try {
          addTransitLayers(activeMap);
          let rich = false;
          try {
            rich = canShowBuildings(deviceFacts(canvas!));
            buildingsReady.current = rich && addBuildings(activeMap);
            showBuildings(
              activeMap,
              buildingsReady.current && shownMode.current === "3d",
            );
          } catch {
            buildingsReady.current = false;
          }
          latest.current.props.onCapabilities?.(rich);
          const vehicles = new BusModelLayer(
            parseCrowdingPreview(
              new URLSearchParams(window.location.search).get("crowding"),
            ),
          );
          busLayerRef.current = vehicles;
          vehicles.setHaloColor(latest.current.props.festive?.busGlow ?? null);
          activeMap.addLayer(vehicles);
          const stands = new StandModelLayer();
          standLayerRef.current = stands;
          // Under the basemap's labels, so decorations never hide a place or stop name.
          activeMap.addLayer(
            stands,
            activeMap.getStyle().layers.find((layer) => layer.type === "symbol")
              ?.id,
          );
          ready.current = true;
          syncBuses();
          setScene(activeMap, latest.current.scene, null);
          appliedScene.current = latest.current.scene;
          applyFocus(activeMap, latest.current.focus);
          setStatus("ready");
        } catch {
          markUnavailable();
        }
      });
      const tapBus = (id: string): boolean => {
        const { buses, selectedBus, onBusSelect, onFollowEvent } =
          latest.current.props;
        const bus = buses.find((candidate) => busKey(candidate) === id);
        if (!bus) return false;
        const alreadySelected =
          Boolean(selectedBus) && busKey(selectedBus!) === id;
        if (alreadySelected) onFollowEvent({ type: "tapSelected" });
        else onBusSelect(bus);
        return true;
      };
      activeMap.on("click", (event) => {
        if (!ready.current) return;
        const { pickMode, onPickPoint } = latest.current.props;
        if (pickMode && onPickPoint) {
          onPickPoint({
            latitude: event.lngLat.lat,
            longitude: event.lngLat.lng,
          });
          return;
        }
        const busId = busLayerRef.current?.pick(event.point);
        if (busId && tapBus(busId)) return;
        if (!activeMap.getLayer(STOP_HIT)) return;
        const nearest = nearestStop(
          activeMap,
          event.point,
          latest.current.scene.stopLookup,
        );
        latest.current.props.onStopSelect(nearest ?? null);
      });
      let hoverKey: string | null = null;
      const setHover = (key: string | null) => {
        if (key === hoverKey) return;
        if (hoverKey !== null)
          activeMap.setFeatureState(
            { source: STOPS, id: hoverKey },
            { hover: false },
          );
        hoverKey = key;
        if (key !== null)
          activeMap.setFeatureState(
            { source: STOPS, id: key },
            { hover: true },
          );
      };
      activeMap.on("mousemove", (event) => {
        if (!ready.current || !activeMap.getLayer(STOP_HIT)) return;
        const overBus = busLayerRef.current?.pick(event.point);
        const overStop = overBus
          ? undefined
          : nearestStop(
              activeMap,
              event.point,
              latest.current.scene.stopLookup,
            );
        if (window.matchMedia("(hover: hover)").matches)
          setHover(overStop ? stopKey(overStop) : null);
        canvas!.style.cursor = latest.current.props.pickMode
          ? "crosshair"
          : overStop || overBus
            ? "pointer"
            : "";
      });
      activeMap.on("mouseout", () => {
        if (ready.current) setHover(null);
      });
      // A two-finger pinch also reports a small drag, so only one-finger touch
      // drags count.
      let dragStart: { x: number; y: number } | null = null;
      activeMap.on("dragstart", (event) => {
        dragStart = isMultiTouch(event.originalEvent)
          ? null
          : pointerPoint(event.originalEvent);
      });
      activeMap.on("drag", (event) => {
        const point = pointerPoint(event.originalEvent);
        if (!dragStart || !point || isMultiTouch(event.originalEvent)) return;
        latest.current.props.onFollowEvent({
          type: "drag",
          distance: dragDistance(dragStart, point),
        });
      });
      activeMap.on("dragend", () => {
        dragStart = null;
      });
      activeMap.on("movestart", (event) => {
        if (
          event.originalEvent instanceof KeyboardEvent &&
          event.originalEvent.key.startsWith("Arrow")
        )
          latest.current.props.onFollowEvent({ type: "pan" });
      });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(container.current);
      }
      window.addEventListener("resize", resize);
    } catch {
      setStatus("unavailable");
    }
    return () => {
      disposed = true;
      ready.current = false;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      canvas?.removeEventListener("webglcontextlost", contextLost);
      if (mapRef.current === map) mapRef.current = null;
      liveControlRef.current = null;
      modeControlRef.current = null;
      buildingsReady.current = false;
      busLayerRef.current = null;
      standLayerRef.current = null;
      map?.remove();
    };
  }, [attempt, applyFocus]);

  useEffect(() => {
    liveControlRef.current?.update(showLive);
  }, [showLive]);

  useEffect(() => {
    const state = tilt.current;
    state.mode = mapMode;
    modeControlRef.current?.update(mapMode);
    const map = mapRef.current;
    if (!map || status !== "ready" || shownMode.current === mapMode) return;
    shownMode.current = mapMode;
    const threeD = mapMode === "3d";
    showBuildings(map, threeD && buildingsReady.current);
    if (threeD) map.setVerticalFieldOfView(ISOMETRIC_FOV);
    steerPitch(map, state, threeD ? pitchForZoom(map.getZoom()) : 0);
  }, [mapMode, status]);

  useEffect(() => {
    liveControlRef.current?.setLabels(liveBusLabels);
    modeControlRef.current?.setLabels(mapModeLabels);
    driveControlRef.current?.setLabels(driveLabels);
  }, [language]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    try {
      setScene(map, scene, appliedScene.current);
      appliedScene.current = scene;
      applyFocus(map, focus);
    } catch {
      ready.current = false;
      setStatus("unavailable");
    }
  }, [scene, focus, applyFocus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    try {
      (map.getSource(SPLIT) as GeoJSONSource | undefined)?.setData(
        busSplit?.data ?? { type: "FeatureCollection", features: [] },
      );
    } catch {
      ready.current = false;
      setStatus("unavailable");
    }
  }, [busSplit, attempt, status]);

  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;
  useEffect(() => {
    const map = mapRef.current;
    const applied = appliedFocus.current;
    if (!map || !ready.current || userMoved.current) return;
    if (applied === null || applied === FOLLOW_FOCUS) return;
    appliedFocus.current = "";
    applyFocus(map, latest.current.focus);
  }, [insetTop, insetBottom, applyFocus]);

  useEffect(() => {
    if (ready.current) syncBuses();
  }, [buses, showLive, routes, routeCatalog, syncBuses]);

  useEffect(() => {
    busLayerRef.current?.setSelected(selectedBusKey);
  }, [selectedBusKey, attempt, status]);

  const busGlow = festive?.busGlow;
  useEffect(() => {
    busLayerRef.current?.setHaloColor(busGlow ?? null);
  }, [busGlow, attempt, status]);

  const roads = useMemo(
    () =>
      routes.flatMap((route) =>
        route.geometry.features.flatMap((feature): Road[] =>
          feature.geometry
            ? realLines(feature.geometry).flatMap((line) =>
                line.type === "LineString"
                  ? [line.coordinates as [number, number][]]
                  : (line.coordinates as [number, number][][]),
              )
            : [],
        ),
      ),
    [routes],
  );
  const readyMap = useCallback(
    () => (ready.current ? (mapRef.current ?? undefined) : undefined),
    [],
  );
  useFestiveMap({
    map: readyMap,
    standLayer: standLayerRef,
    festive,
    threeD: mapMode === "3d",
    roads,
    i18n,
    language,
    revision: `${attempt}:${status}`,
  });

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      busLayerRef.current?.setReducedMotion(preference.matches);
      standLayerRef.current?.setReducedMotion(preference.matches);
      setReducedMotion(preference.matches);
      tilt.current.reducedMotion = preference.matches;
    };
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, [attempt, status]);

  // Follow the bus's animated position, not its 5-second GPS fixes.
  useEffect(() => {
    const map = mapRef.current;
    if (!following || status !== "ready" || !map) return;
    // Zoom gestures keep the bus centred while following.
    const around = { around: "center" as const };
    map.scrollZoom.disable();
    map.scrollZoom.enable(around);
    map.touchZoomRotate.disable();
    map.touchZoomRotate.enable(around);
    let chaseZoom = Math.max(map.getZoom(), CHASE_ZOOM);
    const zoomed = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) chaseZoom = map.getZoom();
    };
    if (isDriving) {
      tilt.current.chase = true;
      map.setMaxPitch(CHASE_MAX_PITCH);
      map.on("zoomend", zoomed);
      map.dragPan.disable();
      map.dragRotate.disable();
      map.keyboard.disable();
      map.touchZoomRotate.disableRotation();
    }
    let bearing = map.getBearing();
    let lastTick = performance.now();
    let frame = 0;
    let phase: "start" | "gliding" | "tracking" = "start";
    let firstGlide = true;
    let lastCentred = "";
    const settle = () => {
      phase = "tracking";
    };
    const tick = () => {
      const position = busLayerRef.current?.positionOf(selectedBusKey);
      const now = performance.now();
      if (isDriving)
        bearing = chaseBearing(
          bearing,
          busLayerRef.current?.headingOf(selectedBusKey),
          now - lastTick,
          reducedMotion,
        );
      lastTick = now;
      if (position && isDriving) {
        const offset: [number, number] = [
          0,
          chaseOffset(
            map.getContainer().clientHeight,
            followShift(latest.current.props.insets),
          ),
        ];
        if (phase === "start" && !map.isMoving()) {
          phase = "gliding";
          map.once("moveend", settle);
          map.easeTo({
            center: position,
            bearing,
            pitch: CHASE_PITCH,
            zoom: chaseZoom,
            offset,
            duration: firstGlide ? CAMERA_MS : CAMERA_MS / 2,
          });
          firstGlide = false;
        } else if (phase === "tracking" && map.isMoving()) {
          phase = "start";
        } else if (phase === "tracking") {
          map.easeTo({
            center: position,
            bearing,
            pitch: CHASE_PITCH,
            zoom: chaseZoom,
            offset,
            duration: 0,
          });
        }
      } else if (position) {
        if (phase === "start" && !map.isMoving()) {
          phase = "gliding";
          map.once("moveend", settle);
          map.easeTo({
            center: position,
            zoom: firstGlide
              ? Math.max(map.getZoom(), FOLLOW_MIN_ZOOM)
              : map.getZoom(),
            // On phones, keep the bus in the map left between header and drawer.
            offset: [0, -followShift(latest.current.props.insets)],
            duration: firstGlide ? CAMERA_MS : CAMERA_MS / 2,
          });
          firstGlide = false;
        } else if (phase === "tracking" && map.isMoving()) {
          phase = "start";
        } else if (phase === "tracking") {
          const shift = followShift(latest.current.props.insets);
          const centred = `${position[0]},${position[1]},${shift}`;
          if (!reducedMotion || centred !== lastCentred) {
            lastCentred = centred;
            const center = shift
              ? map.unproject(
                  map.project(position).add(new maplibregl.Point(0, shift)),
                )
              : position;
            map.jumpTo({ center });
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      map.off("moveend", settle);
      map.scrollZoom.disable();
      map.scrollZoom.enable();
      map.touchZoomRotate.disable();
      map.touchZoomRotate.enable();
      if (isDriving) {
        tilt.current.chase = false;
        map.off("zoomend", zoomed);
        map.dragPan.enable();
        map.dragRotate.enable();
        map.keyboard.enable();
        map.touchZoomRotate.enableRotation();
        map.once("moveend", () => map.setMaxPitch(DEFAULT_MAX_PITCH));
        steerPitch(
          map,
          tilt.current,
          tilt.current.mode === "3d" ? pitchForZoom(map.getZoom()) : 0,
          { bearing: 0 },
        );
      }
    };
  }, [following, selectedBusKey, status, reducedMotion, isDriving]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) labelControls(map);
  }, [language, attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status === "unavailable") return;
    const markers: maplibregl.Marker[] = [];
    for (const [kind, stop, letter] of [
      ["from", from, "A"],
      ["to", to, "B"],
    ] as const) {
      if (!stop || !validStop(stop)) continue;
      const element = document.createElement("div");
      element.className = `relative grid size-8 place-items-center rounded-full border-2 border-white text-sm font-bold text-white shadow-float after:absolute after:top-full after:left-1/2 after:-mt-px after:-translate-x-1/2 after:border-x-[6px] after:border-t-[9px] after:border-x-transparent ${
        kind === "from"
          ? "bg-brand after:border-t-brand"
          : "bg-destination after:border-t-destination"
      }`;
      element.setAttribute("role", "img");
      const stopLabel = stopName(stop, language);
      const name =
        kind === "from" ? t`Start: ${stopLabel}` : t`Destination: ${stopLabel}`;
      element.setAttribute("aria-label", name);
      element.title = name;
      element.textContent = letter;
      markers.push(
        new maplibregl.Marker({ element, anchor: "bottom", offset: [0, -8] })
          .setLngLat([stop.longitude, stop.latitude])
          .addTo(map),
      );
    }
    return () => {
      markers.forEach((marker) => marker.remove());
    };
  }, [from, to, language, attempt, status]);

  // Keyed by value: the caller builds a fresh array on every render.
  const pinKey = (props.pins ?? [])
    .map((pin) => `${pin.kind},${pin.latitude},${pin.longitude}`)
    .join(";");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status === "unavailable" || !pinKey) return;
    const markers = pinKey.split(";").map((item) => {
      const [kind, latitude, longitude] = item.split(",");
      const element = document.createElement("div");
      element.className = `size-4 rounded-full border-2 border-white shadow-float ${
        kind === "from"
          ? "bg-brand"
          : kind === "to"
            ? "bg-destination"
            : "bg-ink ring-4 ring-ink/25"
      }`;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", t`Chosen spot`);
      return new maplibregl.Marker({ element })
        .setLngLat([Number(longitude), Number(latitude)])
        .addTo(map);
    });
    return () => {
      markers.forEach((marker) => marker.remove());
    };
  }, [pinKey, attempt, status, t]);

  // The camera follows chosen spots only; a spot waiting for confirmation
  // shouldn't move the map under the finger.
  const framedKey = (props.pins ?? [])
    .filter((pin) => pin.kind !== "pending")
    .map((pin) => `${pin.latitude},${pin.longitude}`)
    .join(";");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status === "unavailable" || !framedKey) return;
    const spots = framedKey.split(";").map((item) => {
      const [latitude, longitude] = item.split(",");
      return { latitude: Number(latitude), longitude: Number(longitude) };
    });
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? 0
      : 600;
    if (spots.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      spots.forEach((spot) => bounds.extend([spot.longitude, spot.latitude]));
      map.fitBounds(bounds, {
        padding: viewportPadding(latest.current.props.insets),
        maxZoom: 14.5,
        duration,
      });
    } else {
      map.easeTo({
        center: [spots[0].longitude, spots[0].latitude],
        zoom: Math.max(map.getZoom(), 14.5),
        duration,
      });
    }
  }, [framedKey, attempt, status]);

  const warningMessage =
    warning === "permission"
      ? t`Location permission was not granted. You can still choose your stops.`
      : warning === "location"
        ? t`Your location could not be found. Choose your stops instead.`
        : warning === "tiles"
          ? t`Map tiles could not load from the external map provider. Check your internet connection. You can still plan your journey.`
          : t`Some map content could not load. The map or network connection may be unavailable. You can still plan your journey.`;
  return (
    <section
      className="relative h-full w-full"
      aria-label={t`Routes and stops map`}
    >
      <div className="relative h-full w-full">
        <div
          ref={container}
          className={`relative h-full w-full ${status === "unavailable" ? "invisible" : ""}`}
          aria-hidden={status === "unavailable"}
        />
        {status === "ready" && busOverlay}
        {status === "loading" && (
          <p className={MAP_STATUS} role="status">
            {t`Loading map…`}
          </p>
        )}
        {status === "unavailable" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-map px-7 pt-24 pb-56 text-center text-muted"
            role="status"
          >
            <MapPin aria-hidden="true" size={32} />
            <h3 className="mt-4 mb-2 text-2xl text-ink">
              {t`Map unavailable`}
            </h3>
            <p className="max-w-96 text-md leading-relaxed">
              {t`The map needs an internet connection and browser WebGL support. You can still choose stops and plan your journey.`}
            </p>
            <Button
              variant="neutral"
              size="sm"
              className="mt-3"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t`Try map again`}
            </Button>
          </div>
        )}
      </div>
      {warning && status !== "unavailable" && (
        <Notice
          tone="warning"
          icon={<AlertTriangle aria-hidden="true" size={20} />}
          className="absolute top-31 left-7.5 max-w-88 text-xs max-md:top-[calc(var(--header-height,60px)+8px)] max-md:right-16 max-md:left-3 max-md:max-w-none"
          action={
            (warning === "tiles" || warning === "map") && (
              <Button
                variant="neutral"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t`Try map again`}
              </Button>
            )
          }
        >
          {warningMessage}
        </Notice>
      )}
      <div className="sr-only" aria-label={t`Map key`}>
        <span>
          <i aria-hidden="true" />
          {t`Stop`}
        </span>
        {selectedJourney && (
          <span>
            <i aria-hidden="true" />
            {t`Journey stops; rings show boarding and getting off`}
          </span>
        )}
        {showLive && (
          <span>
            <i aria-hidden="true" />
            {t`Live bus; tap to select and follow`}
          </span>
        )}
        {(from || to) && <span>{t`A: Start · B: Destination`}</span>}
      </div>
    </section>
  );
}
