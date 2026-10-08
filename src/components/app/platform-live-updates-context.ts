import { createContext, useContext } from "react";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";
export type LiveUpdatesValue = { revision: number; status: LiveStatus };

export const LiveUpdatesContext = createContext<LiveUpdatesValue>({
  revision: 0,
  status: "connecting",
});

export function usePlatformLiveUpdates() {
  return useContext(LiveUpdatesContext);
}
