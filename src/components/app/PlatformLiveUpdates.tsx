import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  LiveUpdatesContext,
  type LiveStatus,
  usePlatformLiveUpdates,
} from "@/components/app/platform-live-updates-context";

const REFRESH_FALLBACK_MS = 30_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function safeRealtimeError(error?: Error): string | undefined {
  const message = error?.message?.trim();
  if (!message) return undefined;

  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:sb_secret|sb_publishable)_[A-Za-z0-9_-]+\b/g, "[redacted key]")
    .replace(/([?&](?:apikey|token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 180);
}

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
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let connecting = false;
    let connected = false;

    const markChanged = () => {
      if (disposed) return;
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        if (!disposed) setRevision((current) => current + 1);
      }, 150);
    };

    const clearReconnect = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || !navigator.onLine || reconnectTimer !== undefined) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
      reconnectAttempt += 1;
      setStatus("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect(true);
      }, delay);
    };

    const connect = async (replaceChannel = false) => {
      if (disposed || connecting || (!replaceChannel && connected)) return;
      if (!navigator.onLine) {
        setStatus("offline");
        return;
      }
      connecting = true;
      setStatus("connecting");
      try {
        const { data, error } = await supabase.auth.getSession();
        if (disposed) return;
        if (error || !data.session) {
          scheduleReconnect();
          return;
        }

        await supabase.realtime.setAuth(data.session.access_token);
        if (disposed) return;
        if (channel) {
          const previousChannel = channel;
          channel = undefined;
          connected = false;
          await supabase.removeChannel(previousChannel);
          if (disposed) return;
        }

        const nextChannel = supabase
          .channel("platform-admin-live", { config: { private: true } })
          .on("broadcast", { event: "platform_data_changed" }, markChanged);
        channel = nextChannel;
        nextChannel.subscribe((nextStatus, error) => {
          if (disposed || channel !== nextChannel) return;
          if (nextStatus === "SUBSCRIBED") {
            connected = true;
            reconnectAttempt = 0;
            clearReconnect();
            setStatus("live");
            markChanged();
          } else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
            connected = false;
            console.warn("[CEO live updates] Realtime subscription failed; 30-second refresh remains active.", {
              status: nextStatus,
              reason: safeRealtimeError(error) ?? "No additional reason provided",
            });
            if (navigator.onLine) scheduleReconnect();
            else setStatus("offline");
          } else if (nextStatus === "CLOSED") {
            connected = false;
            if (navigator.onLine) scheduleReconnect();
            else setStatus("offline");
          }
        });
      } catch {
        if (!disposed) {
          connected = false;
          if (navigator.onLine) scheduleReconnect();
          else setStatus("offline");
        }
      } finally {
        connecting = false;
      }
    };

    const handleOnline = () => {
      reconnectAttempt = 0;
      clearReconnect();
      connected = false;
      void connect(true);
      markChanged();
    };
    const handleOffline = () => {
      connected = false;
      clearReconnect();
      setStatus("offline");
    };
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
      clearReconnect();
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, []);

  const value = useMemo(() => ({ revision, status }), [revision, status]);
  return <LiveUpdatesContext.Provider value={value}>{children}</LiveUpdatesContext.Provider>;
}

export function PlatformLiveStatus() {
  const { status } = usePlatformLiveUpdates();
  const Icon =
    status === "offline" ? WifiOff : status === "connecting" ? LoaderCircle : Wifi;
  const label =
    status === "live"
      ? "Live updates · 30s refresh backup"
      : status === "offline"
        ? "Offline · showing last data"
        : status === "connecting"
          ? "Realtime connecting · auto-refresh 30s"
          : "Live updates reconnecting · 30s refresh active";
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
      title={
        status === "reconnecting"
          ? "Live push updates are temporarily disconnected. The dashboard still refreshes from protected server data every 30 seconds while this tab is visible, and live updates will reconnect automatically. This does not mean your data was lost."
          : "CEO data loads from protected database functions. It refreshes on live events and polls every 30 seconds while this tab is visible."
      }
    >
      <Icon
        className={`h-3.5 w-3.5 ${status === "connecting" ? "animate-spin" : ""}`}
      />
      {label}
    </span>
  );
}
