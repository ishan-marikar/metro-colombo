import { useLingui } from "@lingui/react/macro";
import { distanceLabel } from "../i18n";
import {
  MAX_WALK_TO_STOP_METERS,
  nearestStops,
  walkMeters,
  type Via,
} from "../lib/geocode";
import { stopName } from "../types";
import type { CatalogStop, Language } from "../types";

const OTHERS_SHOWN = 2;

/** Says which place a stop was picked for, how far it is, and offers the next closest stops. */
export function ViaNote({
  label,
  via,
  stop,
  stops,
  language,
  onPick,
}: {
  label: string;
  via: Via;
  stop: CatalogStop;
  stops: CatalogStop[];
  language: Language;
  onPick: (stop: CatalogStop, via: Via) => void;
}) {
  const { t, i18n } = useLingui();
  const stopLabel = stopName(stop, language);
  const distance = distanceLabel(i18n, via.walk);
  const walk = t`${distance} walk`;
  const others =
    via.latitude !== undefined && via.longitude !== undefined
      ? nearestStops(
          { latitude: via.latitude, longitude: via.longitude },
          stops,
          OTHERS_SHOWN + 3,
        )
          .filter(
            ({ stop: other, meters }) =>
              other.id !== stop.id &&
              other.stop_name_en !== stop.stop_name_en &&
              meters <= MAX_WALK_TO_STOP_METERS,
          )
          .slice(0, OTHERS_SHOWN)
      : [];
  return (
    <div className="mb-2 rounded-md bg-tint-50 px-3 py-2.5" role="status">
      <p className="text-xs font-semibold text-muted">
        {label} · {via.name ?? t`Chosen spot`}
      </p>
      <p className="text-sm font-semibold">
        {t`Nearest stop: ${stopLabel} · ${walk}`}
      </p>
      {others.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">{t`Other stops nearby`}</span>
          {others.map(({ stop: other, meters }) => {
            const otherLabel = stopName(other, language);
            const otherDistance = distanceLabel(i18n, walkMeters(meters));
            return (
              <button
                key={other.id}
                type="button"
                className="min-h-8 rounded-full border border-line bg-white px-3 text-xs font-semibold"
                onClick={() =>
                  onPick(other, { ...via, walk: walkMeters(meters) })
                }
              >
                {otherLabel} · {otherDistance}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
