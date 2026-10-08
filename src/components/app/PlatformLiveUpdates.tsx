import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  LiveUpdatesContext,
  type LiveStatus,
  usePlatformLiveUpdates,
} from "@/components/app/platform-live-updates-context";

const REFRESH_FALLBACK_MS = 30_000;

/**
 * Mount only after the CEO route has verified the platform-admin role. Realtime
 * carries a refresh hint only; every view reloads its data through protected RPCs.
 */
export function PlatformLiveUpdatesProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<LiveStatus>(() =>
    typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "connecting",
  );

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let debounceTimer: number | undefined;

    const markChanged = () => {
      if (disposed) return;
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        if (!disposed) setRevision((current) => current + 1);
      }, 150);
    };

    const connect = async () => {
      if (!navigator.onLine) {
        setStatus("offline");
        return;
      }
      setStatus("connecting");
      try {
        const { data, error } = await supabase.auth.getSession();
        if (disposed) return;
        if (error || !data.session) {
          setStatus("reconnecting");
          return;
        }

        await supabase.realtime.setAuth(data.session.access_token);
        if (disposed) return;
        channel = supabase
          .channel("platform-admin-live", { config: { private: true } })
          .on("broadcast", { event: "platform_data_changed" }, markChanged)
          .subscribe((nextStatus) => {
            if (disposed) return;
            if (nextStatus === "SUBSCRIBED") {
              setStatus("live");
              markChanged();
            } else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
              setStatus(navigator.onLine ? "reconnecting" : "offline");
            } else if (nextStatus === "CLOSED") {
              setStatus(navigator.onLine ? "reconnecting" : "offline");
            }
          });
      } catch {
        if (!disposed) setStatus(navigator.onLine ? "reconnecting" : "offline");
      }
    };

    const handleOnline = () => {
      setStatus("connecting");
      markChanged();
      // Supabase Realtime reconnects its channel automatically after the socket
      // returns. Refresh data immediately while that connection is recovering.
    };
    const handleOffline = () => setStatus("offline");
    const handleVisibility = () => {
      if (document.visibilityState === "visible") markChanged();
    };

    void connect();
    const fallbackTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") markChanged();
    }, REFRESH_FALLBACK_MS);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      window.clearInterval(fallbackTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, []);

  const value = useMemo(() => ({ revision, status }), [revision, status]);
  return <LiveUpdatesContext.Provider value={value}>{children}</LiveUpdatesContext.Provider>;
}

export function PlatformLiveStatus() {
  const { status } = usePlatformLiveUpdates();
  const Icon = status === "live" ? Wifi : status === "offline" ? WifiOff : LoaderCircle;
  const label =
    status === "live"
      ? "Live data connected"
      : status === "offline"
        ? "Offline · reconnecting automatically"
        : "Connecting · automatic refresh is active";
  const color =
    status === "live"
      ? "text-success"
      : status === "offline"
        ? "text-muted-foreground"
        : "text-gold";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs ${color}`}
      role="status"
      aria-live="polite"
      title="CEO data is refreshed from protected Supabase RPCs."
    >
      <Icon
        className={`h-3.5 w-3.5 ${status === "connecting" || status === "reconnecting" ? "animate-spin" : ""}`}
      />
      {label}
    </span>
  );
}
