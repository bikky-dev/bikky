import { useSyncExternalStore } from "react";
import { getSelectedDestination, subscribeDestination } from "./destinationStore";

/**
 * React hook that returns the currently-selected destination name (or null).
 * Re-renders subscribers when the user changes it via DestinationSelector.
 *
 * Pages should include the returned value in their useEffect dependency arrays
 * to re-fetch when the destination changes.
 */
export function useDestination(): string | null {
  return useSyncExternalStore(subscribeDestination, getSelectedDestination, () => null);
}
