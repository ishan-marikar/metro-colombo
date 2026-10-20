import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowRight,
  MapPin,
  Navigation,
  RotateCcw,
  Route as RouteIcon,
  Search,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGeometry, useAllRouteGeometries, useRouteStops } from "./api";
import { track } from "./lib/analytics";
import { MAP_STATUS } from "./classNames";
import { AppHeader } from "./components/AppHeader";
import { BusCard } from "./components/BusCard";
import { PrivacyChoicesLink } from "./components/ConsentPrompt";
import { HowToUse } from "./components/HowToUse";
import JourneyResults, { journeyKey } from "./components/JourneyResults";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { MapLegend } from "./components/MapLegend";
import { PhoneDrawer } from "./components/PhoneDrawer";
import { RouteDetail, RouteList } from "./components/RoutesPanel";
import { StopCard } from "./components/StopCard";
import { TrackingPanel } from "./components/TrackingPanel";
import type { Via } from "./lib/geocode";
import { TripForm } from "./components/TripForm";
import { TripSummary } from "./components/TripSummary";
import { Button, buttonClass } from "./components/ui/Button";
import { cardClass } from "./components/ui/Card";
import { Eyebrow } from "./components/ui/Eyebrow";
import { IconButton } from "./components/ui/IconButton";
import { Notice } from "./components/ui/Notice";
import { Tabs } from "./components/ui/Tabs";
import { intentSnap, snapHeights, type Snap } from "./lib/drawerSnap";
import type { FollowState } from "./lib/follow";
import { useLanguage } from "./lib/language";
import { festiveStops } from "./lib/occasions";
import { findStop, type RecentStop } from "./lib/recentTrips";
import { routeColor } from "./lib/routeColor";
import { sameStop } from "./lib/stopCard";
import { useMediaQuery } from "./lib/useMediaQuery";
import { OccasionGreeting } from "./occasions/OccasionGreeting";
import { OccasionLayers } from "./occasions/OccasionLayers";
import { useOccasion } from "./occasions/useOccasion";
import {
  useElementHeight,
  useSafeAreaBottom,
  useViewportHeight,
} from "./lib/useViewport";
import { TransitDataProvider, useTransitData } from "./state/TransitData";
import { useBusJourney } from "./state/useBusJourney";
import { useBusSelection } from "./state/useBusSelection";
import { useLiveBuses } from "./state/useLiveBuses";
import { useMapLayers } from "./state/useMapLayers";
import { useRouteBrowser } from "./state/useRouteBrowser";
import { useTracking } from "./state/useTracking";
import { useTrip } from "./state/useTrip";
import {
  busDirection,
  busKey,
  findLiveBus,
  isOnRide,
  type CatalogStop,
  type JourneyOption,
  type LiveBus,
  type Ride,
  type Stop,
} from "./types";

const FOOTER_LINK =
  "font-semibold underline underline-offset-2 hover-fine:text-ink";
import { distanceLabel } from "./i18n";
import { stopName } from "./types";
const MapView = lazy(() => import("./components/MapView"));

const NO_BUSES: LiveBus[] = [];
const POPULAR_STOPS = ["makumbura", "colombo fort", "kottawa"];
const CONTROLS_PX = 210;
const TRACK_REFRESH_MS = 60_000;

function pinsOf(trip: {
  pending: { point: { latitude: number; longitude: number } } | null;
  from: CatalogStop | null;
  to: CatalogStop | null;
  fromVia: Via | null;
  toVia: Via | null;
}) {
  const chosen = (
    [
      ["from", trip.fromVia, trip.from],
      ["to", trip.toVia, trip.to],
    ] as const
  ).flatMap(([kind, via, stop]) =>
    via?.latitude !== undefined &&
    via.longitude !== undefined &&
    via.stopId === stop?.id
      ? [{ kind, latitude: via.latitude, longitude: via.longitude }]
      : [],
  );
  return trip.pending
    ? [...chosen, { kind: "pending" as const, ...trip.pending.point }]
    : chosen;
}

export default function App() {
  return (
    <TransitDataProvider>
      <Home />
    </TransitDataProvider>
  );
}

function Home() {
  const { language } = useLanguage();
  const { i18n, t } = useLingui();
  const festive = useOccasion();
  const { routesQuery, routes, catalog, places, routeColors, routeCodeById } =
    useTransitData();
  const [tab, setTab] = useState<"plan" | "routes">("plan");
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [stopFromKeyboard, setStopFromKeyboard] = useState(false);
  const phone = !useMediaQuery("(min-width: 761px)");
  const [snap, setSnap] = useState<Snap>("peek");
  const viewport = useViewportHeight();
  const safeBottom = useSafeAreaBottom();
  const headerRef = useRef<HTMLDivElement>(null);
  const headerHeight = useElementHeight(headerRef);
  const snapHeight = snapHeights(viewport, headerHeight, safeBottom);
  const drawerInset = phone ? snapHeight[snap] : 0;
  // A full-height drawer hides the map anyway, so framing stops at half height.
  const mapInset = Math.min(drawerInset, snapHeight.half);

  // Old links to the phone's full-screen map open with the drawer at peek.
  const navigate = useNavigate({ from: "/" });
  const legacyMap = useSearch({ from: "/" }).map === 1;
  useEffect(() => {
    if (legacyMap)
      void navigate({ search: ({ map: _, ...rest }) => rest, replace: true });
  }, [legacyMap, navigate]);

  const trip = useTrip(catalog.stops);
  const live = useLiveBuses(routeCodeById);
  const browser = useRouteBrowser(routes);
  const { selectedJourney, request, journey, showResults } = trip;
  const { buses, routeCodeOf } = live;
  const tracking = useTracking({
    buses: live.unavailable ? NO_BUSES : buses,
    liveLoaded: live.loaded,
    receivedAt: live.receivedAt,
    feedTimestamp: live.feedTimestamp,
    plan: journey.data,
  });
  const trackingPlan = tab === "plan" && tracking.active;
  const trackedKey = tracking.bus ? busKey(tracking.bus) : null;
  const selection = useBusSelection(live.buses, live.loaded, trackedKey);
  const { selectedBus, release: releaseBus } = selection;
  const trackedSelected =
    tracking.active && !!selectedBus && busKey(selectedBus) === trackedKey;
  // The tracked bus's identity lives in the panel, so the bus card only
  // shows for some other bus picked on the map.
  const showBusPill = !(trackingPlan && trackedSelected);
  const cardBus = selectedBus && showBusPill ? selectedBus : null;
  const trackedFollow: FollowState = tracking.lost
    ? "lost"
    : trackedSelected && selection.followState
      ? selection.followState
      : tracking.liveBus
        ? "lookingAround"
        : "waiting";
  const [frameRide, setFrameRide] = useState<Ride | null>(null);

  const firstRide = selectedJourney?.legs.find((leg) => leg.kind === "ride");
  const firstRideTrip = firstRide?.kind === "ride" ? firstRide.ride : undefined;
  const markRide = tracking.active ? tracking.ride : firstRideTrip;
  const onRide =
    !!cardBus &&
    !!markRide &&
    !!findLiveBus([cardBus], markRide.bus) &&
    isOnRide(cardBus, markRide, Date.now());
  const boardId = onRide ? markRide?.board.id : undefined;
  const alightId = onRide ? markRide?.alight.id : undefined;
  const busJourney = useBusJourney(selectedBus, { boardId, alightId });
  const activeRouteCode =
    tab === "plan" ? firstRideTrip?.route.code : browser.routeCode;
  const activeRoute = routes.find((route) => route.code === activeRouteCode);
  const direction =
    tab === "plan"
      ? firstRideTrip?.direction_id
      : activeRoute?.directions[browser.directionIndex]?.id;
  const routeStops = useRouteStops(activeRoute?.code, direction);
  const geometry = useGeometry(activeRoute?.code, direction);
  const lineKey = `${activeRoute?.code}|${direction}`;
  const [closedLineNotice, setClosedLineNotice] = useState<string | null>(null);
  const lineNoticeShown = geometry.isError && closedLineNotice !== lineKey;
  const [richDevice, setRichDevice] = useState(false);
  const openRouteStops =
    tab === "routes" && browser.routeCode ? routeStops.data?.stops : undefined;
  const followedStops = useMemo(
    () =>
      busJourney?.status === "ready"
        ? busJourney.journey.ahead.map((item) => item.stop)
        : [],
    [busJourney],
  );
  const festiveMap = useMemo(() => {
    if (!festive.theme) return null;
    const journeyStops =
      tab === "plan" && selectedJourney
        ? selectedJourney.legs.flatMap((leg) =>
            leg.kind === "ride"
              ? [leg.ride.board, ...(leg.ride.stops ?? []), leg.ride.alight]
              : [],
          )
        : [];
    return {
      decoration: festive.theme.stops,
      busGlow: festive.theme.busGlow,
      stops: festiveStops(
        [journeyStops, followedStops, openRouteStops ?? []],
        selectedStop ? [selectedStop] : [],
      ),
    };
  }, [
    festive.theme,
    tab,
    selectedJourney,
    followedStops,
    openRouteStops,
    selectedStop,
  ]);
  const { mapRoutes: networkMapRoutes } = useAllRouteGeometries(routes);
  const mapLayers = useMapLayers({
    tab,
    routes,
    buses,
    selectedBus,
    routeCodeOf,
    activeRoute,
    direction,
    selectedJourney,
    resultOptions: showResults ? (journey.data?.options ?? null) : null,
    trackedJourney: tracking.option ?? null,
    trackedBus: tracking.bus ?? null,
    routeStops: routeStops.data?.stops,
    allStops: catalog.stops,
  });

  const selectBus = selection.select;
  const showRouteOf = browser.showRouteOf;
  const handleBusSelect = useCallback(
    (bus: LiveBus | null) => {
      selectBus(bus);
      if (!bus) return;
      const code = routeCodeOf(bus);
      setFrameRide(null);
      if (phone) {
        setSelectedStop(null);
        snapBeforeStop.current = null;
      }
      track("follow_bus", { route: code ?? "unknown" });
      if (code && tab === "routes") showRouteOf(code, bus.direction_id);
    },
    [selectBus, tab, routeCodeOf, showRouteOf, phone],
  );
  const setShowLive = selection.setShowLive;
  const handleShowLiveChange = useCallback(
    (show: boolean) => {
      setShowLive(show);
      if (!show) handleBusSelect(null);
    },
    [setShowLive, handleBusSelect],
  );

  // While tracking, the map comes back to the tracked bus whenever nothing
  // else is picked, e.g. after it drops out of the feed for a moment.
  const trackedLive = tracking.liveBus;
  useEffect(() => {
    if (trackingPlan && trackedLive && !selection.selectedBusId)
      selectBus(trackedLive);
  }, [trackingPlan, trackedLive, selection.selectedBusId, selectBus]);
  const wasTracking = useRef(false);
  const trackedRide = useRef<Ride | null>(null);
  useEffect(() => {
    if (tracking.ride) trackedRide.current = tracking.ride;
  }, [tracking.ride]);
  useEffect(() => {
    if (wasTracking.current && !tracking.active) {
      releaseBus();
      setFrameRide(trackedRide.current);
    }
    wasTracking.current = tracking.active;
  }, [tracking.active, releaseBus]);
  const refetchJourney = journey.refetch;
  useEffect(() => {
    if (!tracking.active) return;
    const interval = window.setInterval(
      () => void refetchJourney(),
      TRACK_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [tracking.active, refetchJourney]);

  const viewJourney = selectedJourney ? journeyKey(selectedJourney) : null;
  const viewBus = selectedBus ? busKey(selectedBus) : null;
  const viewRoute = browser.routeCode;
  const viewStop = selectedStop?.id ?? null;
  const lastView = useRef({
    tab,
    showResults,
    journeyKey: viewJourney,
    busId: viewBus,
    routeCode: viewRoute,
    stopId: viewStop,
    tracking: trackingPlan,
  });
  useEffect(() => {
    const view = {
      tab,
      showResults,
      journeyKey: viewJourney,
      busId: viewBus,
      routeCode: viewRoute,
      stopId: viewStop,
      tracking: trackingPlan,
    };
    const previous = lastView.current;
    lastView.current = view;
    setSnap((current) => intentSnap(previous, view, current));
  }, [
    tab,
    showResults,
    viewJourney,
    viewBus,
    viewRoute,
    viewStop,
    trackingPlan,
  ]);

  const [cardAsideFor, setCardAsideFor] = useState<string | null>(null);
  const busInDrawer = phone && !!cardBus && cardAsideFor !== viewBus;
  const snapNow = useRef(snap);
  snapNow.current = snap;
  const snapBeforeBus = useRef<Snap | null>(null);
  const wasBusInDrawer = useRef(false);
  useEffect(() => {
    if (busInDrawer && !wasBusInDrawer.current)
      snapBeforeBus.current = snapNow.current;
    if (!busInDrawer && wasBusInDrawer.current) {
      if (!viewBus && snapBeforeBus.current) setSnap(snapBeforeBus.current);
      snapBeforeBus.current = null;
    }
    wasBusInDrawer.current = busInDrawer;
  }, [busInDrawer, viewBus]);
  useEffect(() => {
    if (!viewBus) setCardAsideFor(null);
  }, [viewBus]);
  const cardRouteCode = cardBus ? routeCodeOf(cardBus) : undefined;
  const cardRoute = cardRouteCode ?? "unknown";
  const busLine = busJourney?.line;
  const cardDestination = busDirection(
    routes.find((route) => route.code === busLine?.routeCode),
    busLine?.directionId,
  )?.end_location;

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [showResults, tab, trackingPlan]);

  const { pickTarget, startPicking } = trip;
  // Picking is a Plan-tab action: Esc or leaving the tab ends it.
  useEffect(() => {
    if (!pickTarget) return;
    if (tab !== "plan") {
      startPicking(null);
      return;
    }
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") startPicking(null);
    };
    document.addEventListener("keydown", cancelOnEscape);
    return () => document.removeEventListener("keydown", cancelOnEscape);
  }, [pickTarget, tab, startPicking]);
  const stopLabel = trip.pending?.stop
    ? stopName(trip.pending.stop, language)
    : "";
  const distance = trip.pending ? distanceLabel(i18n, trip.pending.walk) : "";
  const walk = t`${distance} walk`;
  const fromName = trip.from ? stopName(trip.from, language) : "";
  const toName = trip.to ? stopName(trip.to, language) : "";
  const popularStops = useMemo(
    () =>
      POPULAR_STOPS.map((name) =>
        catalog.stops.find((stop) => stop.stop_name_en.toLowerCase() === name),
      ).filter((stop): stop is CatalogStop => !!stop),
    [catalog.stops],
  );

  const stopSections = useMemo(
    () => [
      { key: "recent", title: t`Recent`, stops: trip.recentStops },
      { key: "nearby", title: t`Near you`, stops: trip.nearbyStops },
      { key: "popular", title: t`Popular`, stops: popularStops },
    ],
    [t, trip.recentStops, trip.nearbyStops, popularStops],
  );
  const recentName = (stop: RecentStop) => {
    const entry = findStop(catalog.stops, stop);
    return entry ? stopName(entry, language) : stop.name;
  };

  const selectedEntry = useMemo(
    () =>
      selectedStop
        ? catalog.stops.find((item) => item.ids.includes(selectedStop.id))
        : undefined,
    [catalog.stops, selectedStop],
  );
  const snapBeforeStop = useRef<Snap | null>(null);
  const openStop = (stop: Stop, keyboard = false) => {
    if (!selectedStop) snapBeforeStop.current = snap;
    setSelectedStop(stop);
    setStopFromKeyboard(keyboard);
  };
  const closeStop = () => {
    setSelectedStop(null);
    if (snapBeforeStop.current) setSnap(snapBeforeStop.current);
    snapBeforeStop.current = null;
  };
  const changeSnap = (next: Snap) => {
    if (next === "peek" && selectedStop) {
      setSelectedStop(null);
      snapBeforeStop.current = null;
    }
    setSnap(next);
  };
  const chooseStop = (stop: Stop, target: "from" | "to", search: boolean) => {
    const entry = selectedEntry ?? {
      ...stop,
      ids: [stop.id],
      routes: activeRoute ? [activeRoute.code] : [],
    };
    setSelectedStop(null);
    snapBeforeStop.current = null;
    changeTab("plan");
    if (search && target === "to" && trip.from) {
      trip.searchFromStop(trip.from, entry);
      return;
    }
    if (search && target === "from" && trip.to) {
      trip.searchFromStop(entry, trip.to);
      return;
    }
    if (target === "from") {
      trip.changeFrom(entry);
      if (trip.to && sameStop(stop, trip.to)) trip.changeTo(null);
    } else {
      trip.changeTo(entry);
      if (trip.from && sameStop(stop, trip.from)) trip.changeFrom(null);
    }
    setSnap((current) => (current === "peek" ? "half" : current));
  };
  const selectTripJourney = trip.selectJourney;
  const selectJourney = useCallback(
    (option: JourneyOption | null) => {
      selectTripJourney(option);
      setFrameRide(null);
      setSelectedStop(null);
      snapBeforeStop.current = null;
    },
    [selectTripJourney],
  );
  const startTracking = (option: JourneyOption, ride: Ride, bus: LiveBus) => {
    selectJourney(option);
    tracking.start(option, ride, bus);
    handleBusSelect(bus);
  };
  function changeTab(next: "plan" | "routes") {
    if (next === "plan" && tab !== "plan" && !trackedSelected) releaseBus();
    setTab(next);
    setSelectedStop(null);
  }
  const openServedRoute = (code: string, towards: readonly string[]) => {
    const same = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const route = routes.find((item) => item.code === code);
    const direction =
      route?.directions.find((item) =>
        towards.some((place) => same(place, item.end_location)),
      ) ??
      route?.directions.find(
        (item) =>
          !selectedStop || !same(item.end_location, selectedStop.stop_name_en),
      );
    changeTab("routes");
    showRouteOf(code, direction?.id);
  };
  const openRoute = (code: string) => {
    browser.open(code);
    releaseBus();
  };
  const changeDirection = (index: number) => {
    browser.changeDirection(index);
    setSelectedStop(null);
    releaseBus();
  };
  const closeRoute = () => {
    browser.close();
    setSelectedStop(null);
    releaseBus();
  };

  const controlsInset = !phone
    ? 0
    : Math.min(mapInset, viewport - headerHeight - CONTROLS_PX);

  const seeAllStops = () => {
    if (!cardBus) return;
    track("bus_card_all_stops", { route: cardRoute });
    if (!cardRouteCode) return;
    changeTab("routes");
    showRouteOf(cardRouteCode, cardBus.direction_id);
    if (phone) setCardAsideFor(viewBus);
  };
  const [cardBottom, setCardBottom] = useState(0);
  const busCard = cardBus && (
    <BusCard
      bus={cardBus}
      routeCode={cardRouteCode}
      destination={cardDestination}
      state={selection.followState ?? "following"}
      result={busJourney}
      color={routeColor(routeColors.get(cardRoute))}
      language={language}
      expanded={busInDrawer && snap !== "peek"}
      inline={phone}
      onFollow={() => selection.dispatch({ type: "follow" })}
      onRelease={() => handleBusSelect(null)}
      onExpand={(expanded) => setSnap(expanded ? "half" : "peek")}
      onSeeAllStops={seeAllStops}
      onFloatingBottom={setCardBottom}
    />
  );

  const panelLabel = tab === "plan" ? t`Plan your bus trip` : t`Bus routes`;
  // On phones the panel scrolls only at full height; lower, a drag on it
  // moves the drawer.
  const panelScrolls = !phone || snap === "full";
  const formRef = useRef<HTMLDivElement>(null);
  const whereToBar = phone && snap === "peek" && tab === "plan" && !showResults;
  const stopCard = selectedStop && (
    <StopCard
      key={selectedStop.id}
      stop={selectedStop}
      entry={selectedEntry}
      language={language}
      routeColors={routeColors}
      from={trip.from}
      to={trip.to}
      inline={phone}
      focusHeading={stopFromKeyboard}
      onClose={closeStop}
      onChoose={(target, search) => chooseStop(selectedStop, target, search)}
      onOpenRoute={openServedRoute}
    />
  );
  // On phones a selected stop's card stands in for the drawer's content,
  // which stays mounted underneath to come back as it was.
  const stopInDrawer = phone && !!selectedStop;
  const cardInDrawer = stopInDrawer || busInDrawer;
  const panel = (
    <>
      {cardInDrawer && (
        <div
          className={`min-h-0 flex-1 overscroll-contain ${
            panelScrolls ? "touch-pan-y overflow-y-auto" : "overflow-hidden"
          }`}
          data-vaul-no-drag={panelScrolls ? "" : undefined}
        >
          {stopInDrawer ? stopCard : busCard}
        </div>
      )}
      {whereToBar && !cardInDrawer && (
        <div className="px-4 pb-2">
          <button
            type="button"
            className={`flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left ${cardClass()}`}
            onClick={() =>
              formRef.current
                ?.querySelector<HTMLInputElement>('[role="combobox"]')
                ?.focus({ preventScroll: true })
            }
          >
            <Search size={20} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-xl font-semibold tracking-tight">
                {t`Where to?`}
              </span>
              {toName && (
                <span className="block truncate text-sm text-muted">
                  {toName}
                </span>
              )}
            </span>
          </button>
        </div>
      )}
      <Tabs
        className={`border-b border-line px-6 pt-4.5 pb-3.5 max-md:px-4 max-md:pt-0 max-md:pb-2 ${
          trackingPlan || cardInDrawer ? "max-md:hidden" : ""
        }`}
        label={t`Explore Metro`}
        value={tab}
        onChange={changeTab}
        tabs={[
          {
            value: "plan",
            icon: <Navigation size={19} />,
            label: t`Plan a trip`,
          },
          {
            value: "routes",
            icon: <RouteIcon size={20} />,
            label: t({ message: "Bus routes", context: "tab" }),
          },
        ]}
      />
      <div
        ref={panelRef}
        hidden={cardInDrawer}
        className={`min-h-0 flex-1 overscroll-contain px-7.5 pt-7.5 pb-5 max-lg:px-6 max-lg:py-6 max-md:px-4 max-md:pt-3 max-md:pb-6 2xl:px-10 2xl:py-9 ${
          panelScrolls ? "touch-pan-y overflow-y-auto" : "overflow-hidden"
        }`}
        data-vaul-no-drag={phone && panelScrolls ? "" : undefined}
      >
        {trackingPlan ? (
          <div key="tracking">
            <TrackingPanel
              tracking={tracking}
              language={language}
              routeColors={routeColors}
              followState={trackedFollow}
              onFollow={() => {
                if (trackedSelected) selection.dispatch({ type: "follow" });
                else if (tracking.liveBus) handleBusSelect(tracking.liveBus);
              }}
              onStop={tracking.stop}
            />
          </div>
        ) : tab === "plan" && showResults && request ? (
          <div key="trip" className="motion-safe:animate-page-forward">
            <TripSummary
              fromName={fromName}
              toName={toName}
              date={request.date}
              onEdit={() => trip.setTripOpen(false)}
            />
            <JourneyResults
              plan={journey.data}
              loading={journey.isFetching}
              error={journey.error}
              language={language}
              selected={selectedJourney}
              onSelect={selectJourney}
              routeColors={routeColors}
              liveBuses={live.unavailable ? NO_BUSES : buses}
              onShowBus={handleBusSelect}
              onTrack={startTracking}
              onRetry={() => void journey.refetch()}
              onNextDay={trip.searchNextDay}
            />
          </div>
        ) : tab === "plan" ? (
          <div
            key="form"
            className={request ? "motion-safe:animate-page-back" : ""}
          >
            <h1 className="sr-only">{t`Where would you like to go?`}</h1>
            <div
              ref={formRef}
              // Picking a stop on a phone lifts the drawer to full height, under
              // the full-screen stop sheet.
              onFocusCapture={(event) => {
                if (phone && event.target.getAttribute("role") === "combobox")
                  setSnap("full");
              }}
            >
              <TripForm
                from={trip.from}
                to={trip.to}
                fromVia={trip.fromVia}
                toVia={trip.toVia}
                date={trip.date}
                onFromChange={trip.changeFrom}
                onToChange={trip.changeTo}
                onSwap={trip.swap}
                onDateChange={trip.changeDate}
                onSubmit={trip.submit}
                searching={journey.isFetching}
                invalidSameStop={trip.invalidSameStop}
                stops={catalog.stops}
                stopsLoading={catalog.loading || routesQuery.isPending}
                places={places}
                routeColors={routeColors}
                language={language}
                locationBusy={trip.locationBusy}
                locationMessage={trip.locationMessage}
                onLocate={trip.locate}
                onPickOnMap={(target) => {
                  trip.startPicking(target);
                  if (phone) setSnap("peek");
                }}
                fromIsNearest={trip.fromIsNearest}
                stopSections={stopSections}
              />
            </div>
            {trip.recentTrips.length > 0 && (
              <div className="mt-7 max-md:mt-6">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-muted">
                    {t`Recent trips`}
                  </h2>
                  <Button variant="quiet" onClick={trip.clearRecent}>
                    {t({ message: "Clear", context: "recent trips" })}
                  </Button>
                </div>
                <ul className="divide-y divide-line">
                  {trip.recentTrips.map((recent) => {
                    const start = recentName(recent.from);
                    const end = recentName(recent.to);
                    // Rows wait for the stop catalog to find their stops.
                    const ready =
                      !!findStop(catalog.stops, recent.from) &&
                      !!findStop(catalog.stops, recent.to);
                    return (
                      <li
                        key={`${recent.from.code}-${recent.to.code}`}
                        className="flex items-center gap-1"
                      >
                        <button
                          type="button"
                          className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-base font-semibold text-ink disabled:opacity-50 hover-fine:bg-tint-50"
                          aria-label={t`Find buses from ${start} to ${end}`}
                          disabled={!ready}
                          onClick={() => trip.searchRecent(recent)}
                        >
                          <span className="truncate">{start}</span>
                          <ArrowRight
                            size={16}
                            className="shrink-0 text-muted"
                            aria-hidden="true"
                          />
                          <span className="truncate">{end}</span>
                        </button>
                        <IconButton
                          variant="plain"
                          label={t`Find buses for the way back, from ${end} to ${start}`}
                          disabled={!ready}
                          onClick={() => trip.searchRecent(recent, true)}
                        >
                          <RotateCcw size={17} aria-hidden="true" />
                        </IconButton>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {!request && popularStops.length > 0 && (
              <div className="mt-7 max-md:mt-6">
                <h2 className="mb-2.5 text-sm font-semibold text-muted">
                  {t`Popular starting stops`}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {popularStops.map((stop) => (
                    <Button
                      variant="neutral"
                      size="sm"
                      key={stop.id}
                      onClick={() => trip.changeFrom(stop)}
                    >
                      <MapPin size={14} />
                      {stopName(stop, language)}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <p
              className="mb-4 text-sm leading-relaxed text-muted"
              hidden={!!activeRoute}
            >
              {t`Open a route to see its stops and where its buses are now.`}
            </p>
            {routesQuery.isPending && (
              <p role="status">{t`Loading bus routes…`}</p>
            )}
            {!activeRoute ? (
              <RouteList
                routes={routes}
                stops={catalog.stops}
                liveCountByRoute={live.liveCountByRoute}
                onOpen={(route) => openRoute(route.code)}
              />
            ) : (
              <RouteDetail
                route={activeRoute}
                directionIndex={browser.directionIndex}
                onDirectionChange={changeDirection}
                stops={routeStops.data?.stops}
                stopsPending={routeStops.isPending}
                stopsError={routeStops.isError}
                onRetryStops={() => void routeStops.refetch()}
                buses={buses}
                liveUnavailable={live.unavailable}
                selectedBusId={selection.selectedBusId}
                onBusSelect={handleBusSelect}
                selectedStopId={selectedStop?.id}
                onStopSelect={(stop, keyboard) =>
                  stop ? openStop(stop, keyboard) : closeStop()
                }
                onBack={closeRoute}
                language={language}
              />
            )}
          </>
        )}
        {routesQuery.isError && (
          <Notice
            tone="danger"
            role="alert"
            className="my-4"
            action={
              <Button variant="link" onClick={() => void routesQuery.refetch()}>
                {t`Try again`}
              </Button>
            }
          >
            {t`We can’t connect to Metro right now.`}
          </Notice>
        )}
        {!!catalog.errors.length && (
          <Notice
            tone="danger"
            role="status"
            className="my-4"
            action={
              <Button variant="link" onClick={catalog.refetch}>
                {t`Load missing stops`}
              </Button>
            }
          >
            {t`Some stops couldn’t be loaded. Search may be incomplete.`}
          </Notice>
        )}
        <HowToUse hidden={tab === "plan" && showResults} />
      </div>
      <footer className="flex min-h-11 flex-col items-center gap-0.5 border-t border-line px-4 pt-2.5 pb-[calc(8px+env(safe-area-inset-bottom))] text-center text-2xs leading-normal text-muted">
        <p className="text-balance">
          <Trans>
            Not affiliated with{" "}
            <a className={FOOTER_LINK} href="https://lankametro.lk">
              Lanka Metro Transit
            </a>{" "}
            or the official{" "}
            <a
              className={FOOTER_LINK}
              href="https://play.google.com/store/apps/details?id=com.lankametrotransit.lmtgo"
            >
              LMT GO app
            </a>
            .
          </Trans>
        </p>
        <div className="flex flex-wrap justify-center gap-x-5 empty:hidden">
          <Link
            className={`${FOOTER_LINK} inline-flex min-h-9 items-center md:hidden`}
            to="/docs"
          >
            API
          </Link>
          <Link
            className={`${FOOTER_LINK} inline-flex min-h-9 items-center md:hidden`}
            to="/data"
          >
            Data
          </Link>
          <PrivacyChoicesLink className="min-h-9 max-md:inline-flex max-md:items-center md:min-h-0" />
          <a
            className={`${FOOTER_LINK} min-h-9 max-md:inline-flex max-md:items-center md:min-h-0`}
            href="https://stats.uptimerobot.com/uqLc9XQ7vz"
          >
            {t`Service status`}
          </a>
          <a
            className={`${FOOTER_LINK} min-h-9 max-md:inline-flex max-md:items-center md:min-h-0`}
            href="https://github.com/ishan-marikar/metro-colombo"
          >
            GitHub
          </a>
        </div>
      </footer>
    </>
  );

  return (
    <>
      <div
        className="flex h-dvh flex-col max-md:overflow-hidden"
        style={
          {
            "--drawer-inset": `${drawerInset}px`,
            "--map-controls-inset": `${controlsInset}px`,
            "--header-height": `${headerHeight}px`,
          } as CSSProperties
        }
      >
        <div
          ref={headerRef}
          className="relative z-40 max-md:absolute max-md:inset-x-0 max-md:top-0"
        >
          <AppHeader
            homeLabel={t`Metro home`}
            reloadHome
            className="max-md:border-line/70 max-md:bg-paper/80 max-md:backdrop-blur-md max-md:reduce-transparency:bg-paper max-md:reduce-transparency:backdrop-blur-none"
          >
            <div className="flex items-center gap-3 max-md:gap-1.5">
              <Link
                className={`${buttonClass({
                  variant: "neutral",
                  size: "xs",
                  pill: true,
                })} max-[359px]:px-2`}
                to="/docs"
              >
                API
              </Link>
              <Link
                className={`${buttonClass({
                  variant: "neutral",
                  size: "xs",
                  pill: true,
                })} max-[359px]:px-2`}
                to="/data"
              >
                Data
              </Link>
              <LanguageSwitcher />
            </div>
          </AppHeader>
        </div>
        <main className="grid min-h-0 flex-1 grid-cols-[460px_minmax(0,1fr)] max-lg:grid-cols-[415px_minmax(0,1fr)] max-md:block 2xl:grid-cols-[490px_minmax(0,1fr)]">
          {phone ? (
            <PhoneDrawer
              label={panelLabel}
              snap={snap}
              heights={snapHeight}
              viewport={viewport}
              onSnapChange={changeSnap}
            >
              {panel}
            </PhoneDrawer>
          ) : (
            <section
              className="z-10 flex min-h-0 flex-col border-r border-line bg-paper"
              aria-label={panelLabel}
            >
              {panel}
            </section>
          )}
          <section
            className="relative min-h-0 overflow-hidden bg-map max-md:fixed max-md:inset-0 max-md:z-0"
            aria-label={t`Bus route map`}
          >
            <Suspense
              fallback={
                <p className={MAP_STATUS} role="status">
                  {t`Loading map…`}
                </p>
              }
            >
              <MapView
                routes={networkMapRoutes}
                routeCatalog={routes}
                routeLock={mapLayers.routeLock}
                emphasizeRoutes={mapLayers.emphasizeRoutes}
                stops={mapLayers.stops}
                buses={mapLayers.buses}
                from={tab === "plan" ? trip.from : null}
                to={tab === "plan" ? trip.to : null}
                selectedStop={selectedStop}
                selectedJourney={tab === "plan" ? selectedJourney : null}
                selectedBus={selectedBus}
                followBus={selection.followBus}
                frameRide={tab === "plan" ? frameRide : null}
                busOverlay={phone ? null : busCard}
                busLine={busLine}
                festive={festiveMap}
                onCapabilities={setRichDevice}
                language={language}
                pickMode={tab === "plan" && trip.pickTarget !== null}
                onPickPoint={trip.pickPoint}
                pins={tab === "plan" && !trip.showResults ? pinsOf(trip) : []}
                onStopSelect={(stop) => (stop ? openStop(stop) : closeStop())}
                onBusSelect={handleBusSelect}
                onFollowEvent={(event) => {
                  if (event.type === "tapSelected" && cardAsideFor) {
                    setCardAsideFor(null);
                    return;
                  }
                  selection.dispatch(event);
                }}
                showLive={selection.showLive}
                onShowLiveChange={handleShowLiveChange}
                insets={
                  phone
                    ? { top: headerHeight, bottom: mapInset }
                    : cardBottom
                      ? { top: cardBottom, bottom: 0 }
                      : undefined
                }
              />
            </Suspense>
            {trip.pickTarget && (
              <div className="absolute top-7.5 left-1/2 z-20 flex w-max max-w-[calc(100%-6rem)] -translate-x-1/2 flex-col items-center gap-2 max-md:top-24">
                <div
                  className="flex items-center gap-3 rounded-full bg-ink py-2 pr-2 pl-5 text-white shadow-float"
                  role="status"
                >
                  <span className="text-sm font-semibold">
                    {trip.pickTarget === "from"
                      ? t`Tap the map to choose your start.`
                      : t`Tap the map to choose your destination.`}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    pill
                    onClick={() => trip.startPicking(null)}
                  >
                    {t`Cancel`}
                  </Button>
                </div>
                {trip.pending && (
                  <div
                    className={`w-72 max-w-full p-3.5 shadow-float ${cardClass()}`}
                    role="status"
                  >
                    {trip.pending.stop ? (
                      <>
                        <p className="text-sm font-semibold">
                          {t`Nearest stop: ${stopLabel} · ${walk}`}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {t`Tap another spot to change it.`}
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          block
                          className="mt-2.5"
                          onClick={() => {
                            trip.confirmPick();
                            setSnap((current) =>
                              current === "peek" ? "half" : current,
                            );
                          }}
                        >
                          {t`Use this spot`}
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-semibold">
                          {t`No bus stop within 5 km of that spot.`}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {t`Tap another spot to change it.`}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {festive.theme && (
              <OccasionLayers
                theme={festive.theme}
                playMoment={festive.playMoment && richDevice}
                onMomentDone={festive.momentDone}
                bottomInset={phone ? mapInset : 0}
              />
            )}
            <div
              className={`pointer-events-none absolute top-7.5 right-19 left-7.5 max-md:hidden ${
                selectedBus || trip.pickTarget ? "hidden" : ""
              }`}
            >
              <div
                className={`inline-flex max-w-full flex-col gap-1 px-4.5 py-3 shadow-float ${cardClass()}`}
              >
                {festive.theme && !activeRoute ? (
                  <OccasionGreeting
                    theme={festive.theme}
                    onTurnOff={festive.turnOff}
                    variant="card"
                  />
                ) : (
                  <>
                    <Eyebrow>
                      {festive.theme
                        ? festive.theme.greeting(i18n)
                        : t`Colombo & beyond`}
                    </Eyebrow>
                    <strong className="text-2xl font-semibold tracking-tight">
                      {activeRoute
                        ? activeRoute.name
                        : t`Find your way around.`}
                    </strong>
                  </>
                )}
              </div>
            </div>
            {festive.theme && !lineNoticeShown && !selectedBus && (
              <div className="pointer-events-none absolute top-[calc(var(--header-height,60px)+8px)] left-3 max-w-[calc(100%-1.5rem)] md:hidden">
                <OccasionGreeting
                  theme={festive.theme}
                  onTurnOff={festive.turnOff}
                  variant="strip"
                />
              </div>
            )}
            {lineNoticeShown && (
              <div
                role="status"
                className="absolute top-31 left-7.5 flex max-w-82 items-center gap-2 rounded-xl border border-warning-200 bg-warning-50 py-1 pr-1 pl-3 text-xs leading-snug text-ink shadow-float max-md:top-[calc(var(--header-height,60px)+8px)] max-md:left-3 max-md:max-w-[calc(100%-1.5rem)]"
              >
                <span>{t`Lanka Metro isn’t sending this route line right now.`}</span>
                <Button
                  variant="link"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void geometry.refetch()}
                >
                  {t`Try again`}
                </Button>
                <IconButton
                  variant="plain"
                  size="sm"
                  label={t`Close`}
                  onClick={() => setClosedLineNotice(lineKey)}
                >
                  <X size={15} aria-hidden="true" />
                </IconButton>
              </div>
            )}
            {!phone && stopCard}
            {/* Phones keep the map clear; MapView still names the key for screen readers. */}
            <MapLegend showLive={selection.showLive} hidden={phone} />
          </section>
        </main>
      </div>
    </>
  );
}
