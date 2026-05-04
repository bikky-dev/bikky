import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getDestinationOptions,
  getSelectedDestination,
  setDestinationOptions,
  setSelectedDestination,
  subscribeDestination,
  type DestinationInfo,
} from "../lib/destinationStore";

interface DestinationsResponse {
  destinations: DestinationInfo[];
}

function useDestinationSelection(): string | null {
  return useSyncExternalStore(subscribeDestination, getSelectedDestination, () => null);
}

function useDestinationOptions(): DestinationInfo[] | null {
  return useSyncExternalStore(subscribeDestination, getDestinationOptions, () => null);
}

export default function DestinationSelector() {
  const selected = useDestinationSelection();
  const options = useDestinationOptions();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (options !== null) return;
    let cancelled = false;
    fetch("/api/destinations")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DestinationsResponse>;
      })
      .then((data) => { if (!cancelled) setDestinationOptions(data.destinations ?? []); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [options]);

  if (loadError) return null;
  if (!options || options.length <= 1) return null;

  return (
    <select
      aria-label="Destination"
      className="w-full rounded-md bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 px-2 py-1.5 hover:border-zinc-600 focus:outline-none focus:border-zinc-500"
      value={selected ?? "all"}
      onChange={(e) => setSelectedDestination(e.target.value)}
    >
      <option value="all">All destinations</option>
      {options.map((d) => (
        <option key={d.name} value={d.name}>
          {d.name}{d.isDefault ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}
