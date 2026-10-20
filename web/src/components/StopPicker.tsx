import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Crosshair,
  Landmark,
  MapPin,
  Navigation,
  Search,
  X,
} from "lucide-react";
import type { I18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { distanceLabel, towards } from "../i18n";
import {
  MAX_WALK_TO_STOP_METERS,
  nearestStop,
  walkMeters,
  type Via,
} from "../lib/geocode";
import { usePlaceName } from "../lib/placeNames";
import { usePlaceSearch } from "../state/usePlaceSearch";
import { useMediaQuery } from "../lib/useMediaQuery";
import { RouteChip } from "./RouteChip";
import { IconButton } from "./ui/IconButton";
import { placeTitle, stopName } from "../types";
import type { CatalogStop, Language, Place } from "../types";

const STATUS = "bg-tint-50 px-3 py-2.5 text-2xs leading-normal text-muted";

type Found = {
  name: string;
  detail: string;
  walk: number;
  latitude: number;
  longitude: number;
};
type Choice = { key: string; stop: CatalogStop; place?: Place; found?: Found };

export interface StopSection {
  key: string;
  title: string;
  stops: readonly CatalogStop[];
}

type Group = { key: string; title?: string; choices: Choice[] };

function startIndex(step: 1 | -1, count: number): number {
  return step === 1 ? 0 : count - 1;
}

function wrapIndex(index: number, count: number): number {
  return (index + count) % count;
}

function walkLabel(i18n: I18n, meters: number): string {
  const distance = distanceLabel(i18n, meters);
  return t(i18n)`${distance} walk`;
}

interface StopPickerProps {
  label: string;
  placeholder: string;
  value: CatalogStop | null;
  stops: CatalogStop[];
  language: Language;
  loading: boolean;
  routeColors: ReadonlyMap<string, string>;
  places: ReadonlyArray<Place>;
  sections?: readonly StopSection[];
  labelNote?: string;
  prominent?: boolean;
  onChange: (stop: CatalogStop | null, via?: Via) => void;
  onPickOnMap?: () => void;
}

export default function StopPicker({
  label,
  placeholder,
  value,
  stops,
  language,
  loading,
  routeColors,
  places,
  sections = [],
  labelNote,
  prominent = false,
  onChange,
  onPickOnMap,
}: StopPickerProps) {
  const id = useId();
  const { t, i18n } = useLingui();
  const localPlace = usePlaceName();
  const inputId = `${id}-input`;
  const listId = `${id}-choices`;
  const helpId = `${id}-help`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const mobile = useMediaQuery("(max-width: 760px)");
  const typed = value ? "" : draft.trim();
  const query = typed.toLocaleLowerCase();
  const { places: foundPlaces, searching } = usePlaceSearch(typed);
  const groups = useMemo((): Group[] => {
    const matches = (names: (string | undefined)[]) =>
      !query || names.some((name) => name?.toLocaleLowerCase().includes(query));
    const stopChoices = stops
      .filter((stop) =>
        matches([
          stop.stop_name_en,
          stop.stop_name_si,
          stop.stop_name_tm,
          stop.stop_code,
        ]),
      )
      .map((stop) => ({ key: stop.id, stop }));
    if (!query) {
      const shortcuts = sections
        .filter((section) => section.stops.length)
        .map((section) => ({
          key: section.key,
          title: section.title,
          choices: section.stops.map((stop) => ({
            key: `${section.key}-${stop.id}`,
            stop,
          })),
        }));
      // Without any shortcuts the list stays a plain A–Z with no heading.
      const all = shortcuts.length ? t`All stops` : undefined;
      return [...shortcuts, { key: "all", title: all, choices: stopChoices }];
    }
    const placeChoices = places.flatMap((place) => {
      if (!matches([place.name, place.name_si, place.name_ta])) return [];
      const stop =
        stops.find((item) => item.ids.includes(place.stop_id)) ??
        stops.find((item) => item.stop_code === place.stop_code);
      return stop ? [{ key: `place-${place.id}`, stop, place }] : [];
    });
    const foundChoices = foundPlaces.flatMap((place) => {
      const nearest = nearestStop(place, stops);
      return nearest && nearest.meters <= MAX_WALK_TO_STOP_METERS
        ? [
            {
              key: place.key,
              stop: nearest.stop,
              found: {
                name: place.name,
                detail: place.detail,
                walk: walkMeters(nearest.meters),
                latitude: place.latitude,
                longitude: place.longitude,
              },
            },
          ]
        : [];
    });
    const groups: Group[] = [
      { key: "matches", choices: [...placeChoices, ...stopChoices] },
    ];
    if (foundChoices.length)
      groups.push({
        key: "found",
        title: t`Anywhere in Sri Lanka`,
        choices: foundChoices,
      });
    return groups;
  }, [stops, places, foundPlaces, query, sections, t]);
  const choices = useMemo(
    () => groups.flatMap((group) => group.choices),
    [groups],
  );
  // A stop can be listed in a section and again under all stops.
  const stopCount = useMemo(
    () => new Set(choices.map(({ stop }) => stop.id)).size,
    [choices],
  );
  const expanded = open;
  const sheetOpen = expanded && mobile;
  const activeStop = activeIndex >= 0 ? choices[activeIndex]?.stop : undefined;

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!choices.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        !expanded || activeIndex < 0
          ? startIndex(step, choices.length)
          : wrapIndex(activeIndex + step, choices.length),
      );
    } else if (event.key === "Enter" && expanded && activeStop) {
      event.preventDefault();
      choose(activeStop);
    } else if (event.key === "Escape" && expanded) {
      event.preventDefault();
      closePicker();
    }
  };

  useEffect(() => {
    if (!sheetOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => sheetInputRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previous;
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (!expanded || mobile) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded, mobile]);

  useEffect(() => {
    if (expanded && activeStop) {
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, activeIndex, activeStop, listId]);

  function closePicker() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function choose(stop: CatalogStop, via?: Via) {
    setDraft("");
    closePicker();
    onChange(stop, via);
    // Blur, or onFocus would pop the menu (or the phone sheet) right back open.
    inputRef.current?.blur();
    sheetInputRef.current?.blur();
  }

  const help = loading
    ? t`Loading stops…`
    : choices.length === 0
      ? searching
        ? t`Searching places…`
        : t`No matching stops. Try another stop name or a place.`
      : mobile
        ? t({
            message: plural(stopCount, {
              one: "# stop. Tap one to select.",
              other: "# stops. Tap one to select.",
            }),
          })
        : t({
            message: plural(stopCount, {
              one: "# stop. Use the arrow keys to choose, then press Enter.",
              other: "# stops. Use the arrow keys to choose, then press Enter.",
            }),
          });

  const displayValue = value ? stopName(value, language) : draft;

  function onInputChange(next: string) {
    if (next === displayValue) return;
    setDraft(next);
    setActiveIndex(-1);
    setOpen(true);
    if (value) onChange(null);
  }

  function clearValue() {
    setDraft("");
    setActiveIndex(-1);
    onChange(null);
    setOpen(true);
    if (mobile) sheetInputRef.current?.focus();
    else inputRef.current?.focus();
  }

  const option = (
    { key, stop, place, found }: Choice,
    index: number,
    inSheet: boolean,
  ) => {
    const stopLabel = stopName(stop, language);
    const walk = place
      ? walkLabel(i18n, place.walk_meters)
      : found
        ? walkLabel(i18n, found.walk)
        : "";
    // A landmark is only a shortcut to its stop, so it never shows as chosen.
    const isValue = !place && !found && value?.id === stop.id;
    return (
      <li key={key} role="presentation">
        <button
          type="button"
          id={`${listId}-${index}`}
          role="option"
          tabIndex={-1}
          aria-selected={isValue}
          className={`flex w-full items-start gap-2.5 rounded-md text-left active:bg-tint-100 hover-fine:bg-tint-100 [&>svg]:mt-1 [&>svg]:text-muted ${
            index === activeIndex || isValue ? "bg-tint-100" : ""
          } ${inSheet ? "min-h-14 px-3 py-3.5" : "min-h-13 px-2 py-3"}`}
          onClick={() =>
            choose(
              stop,
              found
                ? { ...found }
                : place
                  ? {
                      name: placeTitle(place, language),
                      walk: place.walk_meters,
                    }
                  : undefined,
            )
          }
          onMouseEnter={() => setActiveIndex(index)}
        >
          {found ? (
            <Navigation size={18} aria-hidden="true" />
          ) : place ? (
            <Landmark size={18} aria-hidden="true" />
          ) : (
            <MapPin size={18} aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-lg leading-normal font-semibold">
              {found
                ? found.name
                : place
                  ? placeTitle(place, language)
                  : stopLabel}
            </span>
            {place || found ? (
              <>
                <span className="mt-0.5 flex items-center gap-1 text-sm text-muted">
                  <MapPin size={13} aria-hidden="true" />
                  <span className="truncate">{stopLabel}</span>
                </span>
                {found?.detail && (
                  <span className="block truncate text-2xs text-muted">
                    {found.detail}
                  </span>
                )}
              </>
            ) : (
              !!stop.towards?.length && (
                <span className="mt-0.5 line-clamp-2 text-xs text-muted">
                  {towards(i18n, stop.towards.map(localPlace).join(" / "))}
                </span>
              )
            )}
          </span>
          {place || found ? (
            <span className="mt-1 shrink-0 text-sm font-semibold whitespace-nowrap">
              {walk}
            </span>
          ) : (
            <span
              className="mt-1 flex max-w-26 flex-wrap justify-end gap-1"
              aria-label={t`Routes`}
            >
              {stop.routes.map((route) => (
                <RouteChip
                  key={route}
                  code={route}
                  color={routeColors.get(route)}
                  size="xs"
                />
              ))}
            </span>
          )}
        </button>
      </li>
    );
  };

  const mapRow = (inSheet: boolean) =>
    onPickOnMap && (
      <button
        type="button"
        // Safari only focuses a clicked button that has a tabindex; without
        // focus the picker's blur handler closes the list before the click lands.
        tabIndex={-1}
        className={`flex w-full items-center gap-2.5 rounded-md text-left text-lg font-semibold active:bg-tint-100 hover-fine:bg-tint-100 ${
          inSheet ? "min-h-14 px-3" : "min-h-13 px-2"
        }`}
        onClick={() => {
          closePicker();
          inputRef.current?.blur();
          sheetInputRef.current?.blur();
          onPickOnMap();
        }}
      >
        <Crosshair size={18} className="text-muted" aria-hidden="true" />
        {t`Choose on map`}
      </button>
    );

  const list = (inSheet: boolean) => {
    let index = 0;
    return (
      <ul
        id={listId}
        className={
          inSheet
            ? "h-full overflow-y-auto overscroll-contain p-1"
            : "max-h-66 overflow-y-auto overscroll-contain p-1 max-md:max-h-[min(40vh,280px)]"
        }
        role="listbox"
        aria-label={label}
        aria-busy={loading}
      >
        {onPickOnMap && <li role="presentation">{mapRow(inSheet)}</li>}
        {groups.map((group) => {
          const options = group.choices.map((choice) =>
            option(choice, index++, inSheet),
          );
          if (!group.title) return options;
          const headingId = `${listId}-${group.key}`;
          return (
            <li key={group.key} role="group" aria-labelledby={headingId}>
              <span
                id={headingId}
                role="presentation"
                className="block px-2 pt-3 pb-1 text-xs font-semibold text-muted"
              >
                {group.title}
              </span>
              <ul role="presentation">{options}</ul>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div
      className="relative min-w-0"
      ref={rootRef}
      onBlur={(event) => {
        if (mobile || sheetOpen) return;
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closePicker();
        }
      }}
    >
      <label
        className="block text-md font-semibold text-muted"
        htmlFor={inputId}
      >
        {label}
        {labelNote && <span className="font-normal"> {labelNote}</span>}
      </label>
      <div className="relative flex min-w-0 items-center">
        <input
          ref={inputRef}
          id={inputId}
          className={`min-h-11 w-full bg-transparent py-2 font-semibold ${prominent ? "text-2xl tracking-tight max-md:text-xl" : "text-lg"} text-ink placeholder:font-normal placeholder:text-muted ${sheetOpen ? "cursor-pointer" : ""}`}
          role="combobox"
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={displayValue}
          readOnly={mobile}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-describedby={expanded ? helpId : undefined}
          aria-activedescendant={
            expanded && activeStop ? `${listId}-${activeIndex}` : undefined
          }
          onFocus={() => {
            setOpen(true);
            setActiveIndex(-1);
          }}
          onClick={() => {
            if (mobile) setOpen(true);
          }}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onListKeyDown}
        />
        {(value || draft) && (
          <IconButton
            variant="plain"
            className="-mr-2.5"
            label={t`Clear ${label}`}
            onClick={clearValue}
          >
            <X size={18} aria-hidden="true" />
          </IconButton>
        )}
      </div>

      {expanded && !mobile && (
        <div className="absolute top-[calc(100%+8px)] -right-10 -left-8 z-20 overflow-hidden rounded-lg border border-line-strong bg-white shadow-menu max-md:inset-x-0">
          <p
            id={helpId}
            className={`border-b border-line ${STATUS}`}
            role="status"
            aria-live="polite"
          >
            {help}
          </p>
          {list(false)}
        </div>
      )}

      {/* In the body, so the phone drawer's transform can't trap it. */}
      {sheetOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex flex-col bg-paper pt-[env(safe-area-inset-top)]"
            data-vaul-no-drag
            role="dialog"
            aria-modal="true"
            aria-label={label}
          >
            <div className="flex items-center gap-1.5 border-b border-line py-2 pr-3 pl-1.5">
              <IconButton
                variant="plain"
                label={t`Close`}
                onClick={closePicker}
              >
                <ArrowLeft size={22} aria-hidden="true" />
              </IconButton>
              <div className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-full bg-field pr-1.5 pl-4 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
                <Search
                  className="shrink-0 text-muted"
                  size={18}
                  aria-hidden="true"
                />
                <input
                  ref={sheetInputRef}
                  className="min-h-11 min-w-0 flex-1 bg-transparent text-lg font-semibold text-ink outline-none placeholder:font-normal placeholder:text-muted"
                  role="combobox"
                  type="text"
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={placeholder}
                  value={displayValue}
                  aria-label={label}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-describedby={helpId}
                  aria-activedescendant={
                    activeStop ? `${listId}-${activeIndex}` : undefined
                  }
                  onChange={(event) => onInputChange(event.target.value)}
                  onKeyDown={onListKeyDown}
                />
                {displayValue && (
                  <IconButton
                    variant="plain"
                    size="sm"
                    label={t`Clear ${label}`}
                    onClick={clearValue}
                  >
                    <X size={18} aria-hidden="true" />
                  </IconButton>
                )}
              </div>
            </div>
            {/* Spoken always; shown only when there's nothing to list. */}
            <p
              id={helpId}
              className={
                !loading && choices.length === 0
                  ? "px-8 pt-12 text-center text-sm leading-normal text-muted"
                  : "sr-only"
              }
              role="status"
              aria-live="polite"
            >
              {help}
            </p>
            <div className="min-h-0 flex-1 overflow-hidden px-2 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {list(true)}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
