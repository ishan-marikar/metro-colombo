import {
  ArrowDownUp,
  ArrowRight,
  LocateFixed,
  MapPin,
  Search,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { dateLabel } from "../i18n";
import { colomboDate, nextDay } from "../types";
import type { CatalogStop, Language, Place } from "../types";
import type { Via } from "../lib/geocode";
import StopPicker, { type StopSection } from "./StopPicker";
import { Button } from "./ui/Button";
import { cardClass } from "./ui/Card";
import { Field } from "./ui/Field";
import { ViaNote } from "./ViaNote";
import { IconButton } from "./ui/IconButton";

const HELPER = "pb-3 text-sm leading-relaxed";
const CHIP =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold";

type DateChoice = "today" | "tomorrow" | "pick";

function DateChips({
  date,
  onDateChange,
}: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  const { t, i18n } = useLingui();
  const labelId = useId();
  const pickRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const today = colomboDate();
  const tomorrow = nextDay(today);
  const choice: DateChoice = picking
    ? "pick"
    : date === today
      ? "today"
      : date === tomorrow
        ? "tomorrow"
        : "pick";
  const choose = (next: DateChoice) => {
    setPicking(next === "pick");
    if (next === "today") onDateChange(today);
    else if (next === "tomorrow") onDateChange(tomorrow);
    else requestAnimationFrame(() => pickRef.current?.focus());
  };
  const chips: { value: DateChoice; label: string }[] = [
    { value: "today", label: t`Today` },
    { value: "tomorrow", label: t`Tomorrow` },
    {
      value: "pick",
      // A picked date names itself, so the chip reads "Sat, 17 Oct".
      label:
        choice === "pick" && date && !picking
          ? dateLabel(i18n, date)
          : t`Pick a date`,
    },
  ];
  return (
    <div className="mb-4">
      <p id={labelId} className="mb-2 text-sm font-semibold text-muted">
        {t`Travel date`}
      </p>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-labelledby={labelId}
      >
        {chips.map((chip) => (
          <button
            key={chip.value}
            type="button"
            aria-pressed={choice === chip.value}
            className={`${CHIP} ${
              choice === chip.value
                ? "border-ink bg-ink text-white"
                : "border-line bg-white text-ink hover-fine:bg-tint-50"
            }`}
            onClick={() => choose(chip.value)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {choice === "pick" && (
        <Field layout="inline" className="mt-2" label={t`Travel date`}>
          <input
            ref={pickRef}
            type="date"
            className="min-h-9 max-w-44 bg-transparent text-ink max-md:min-h-12 max-md:w-full max-md:max-w-none"
            aria-label={t`Travel date`}
            required
            min={today}
            value={date}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </Field>
      )}
    </div>
  );
}

export function TripForm({
  from,
  to,
  date,
  onFromChange,
  onToChange,
  onSwap,
  onDateChange,
  onSubmit,
  searching,
  invalidSameStop,
  stops,
  stopsLoading,
  places,
  routeColors,
  language,
  locationBusy,
  locationMessage,
  onLocate,
  fromIsNearest,
  stopSections,
  onPickOnMap,
  fromVia,
  toVia,
}: {
  from: CatalogStop | null;
  to: CatalogStop | null;
  fromVia: Via | null;
  toVia: Via | null;
  date: string;
  onFromChange: (stop: CatalogStop | null, via?: Via) => void;
  onToChange: (stop: CatalogStop | null, via?: Via) => void;
  onSwap: () => void;
  onDateChange: (date: string) => void;
  onSubmit: () => void;
  searching: boolean;
  invalidSameStop: boolean;
  stops: CatalogStop[];
  stopsLoading: boolean;
  places: ReadonlyArray<Place>;
  routeColors: ReadonlyMap<string, string>;
  language: Language;
  locationBusy: boolean;
  locationMessage: string;
  onLocate: () => void;
  fromIsNearest: boolean;
  stopSections: readonly StopSection[];
  onPickOnMap: (target: "from" | "to") => void;
}) {
  const { t } = useLingui();
  return (
    <form
      className="relative"
      // The submit handler moves a past date to today instead of letting the browser block the search.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div
        className={`relative flex items-stretch gap-2.5 px-3 py-3.5 max-md:gap-2 ${cardClass()}`}
      >
        <div
          className="flex w-6 flex-col items-center pt-6 pb-5 text-ink"
          aria-hidden="true"
        >
          <MapPin size={19} />
          <i className="my-1 min-h-12 flex-1 border-l-2 border-dotted border-line-strong" />
          <span className="size-3 rounded-full border-2 border-ink" />
        </div>
        <div className="min-w-0 flex-1">
          <StopPicker
            label={t`Where to?`}
            placeholder={t`Type a stop or a place`}
            value={to}
            stops={stops}
            language={language}
            loading={stopsLoading}
            routeColors={routeColors}
            places={places}
            sections={stopSections}
            prominent
            onChange={onToChange}
            onPickOnMap={() => onPickOnMap("to")}
          />
          <div className="my-3 mr-7 border-t border-line" />
          <StopPicker
            label={t`From`}
            labelNote={fromIsNearest ? t`(nearest)` : undefined}
            placeholder={t`Choose a start stop`}
            value={from}
            stops={stops}
            language={language}
            loading={stopsLoading}
            routeColors={routeColors}
            places={places}
            sections={stopSections}
            onChange={onFromChange}
            onPickOnMap={() => onPickOnMap("from")}
          />
        </div>
        <IconButton
          variant="tinted"
          className="-ml-2 self-center max-md:-ml-1"
          label={t`Swap starting and destination stops`}
          disabled={!from && !to}
          onClick={onSwap}
        >
          <ArrowDownUp size={19} />
        </IconButton>
      </div>
      {toVia && to && toVia.stopId === to.id && (
        <ViaNote
          label={t`Where to?`}
          via={toVia}
          stop={to}
          stops={stops}
          language={language}
          onPick={onToChange}
        />
      )}
      {fromVia && from && fromVia.stopId === from.id && (
        <ViaNote
          label={t`From`}
          via={fromVia}
          stop={from}
          stops={stops}
          language={language}
          onPick={onFromChange}
        />
      )}
      <Button
        variant="quiet"
        className="my-1"
        disabled={locationBusy || !stops.length}
        onClick={onLocate}
      >
        <LocateFixed size={17} />
        {locationBusy
          ? t`Finding your location…`
          : t`Use my location for the nearest stop`}
      </Button>
      {locationMessage && (
        <p className={`${HELPER} text-muted`} role="status">
          {locationMessage}
        </p>
      )}
      <DateChips date={date} onDateChange={onDateChange} />
      {invalidSameStop && (
        <p className={`${HELPER} text-danger`} role="alert">
          {t`Choose a different destination from your starting stop.`}
        </p>
      )}
      <Button
        variant="primary"
        size="lg"
        block
        align="start"
        type="submit"
        disabled={!from || !to || !date || invalidSameStop}
        // Stays focusable while searching so keyboard focus isn't lost.
        aria-disabled={searching}
      >
        <Search size={20} />
        {searching ? t`Finding your buses…` : t`Find my bus`}
        <ArrowRight size={20} />
      </Button>
    </form>
  );
}
