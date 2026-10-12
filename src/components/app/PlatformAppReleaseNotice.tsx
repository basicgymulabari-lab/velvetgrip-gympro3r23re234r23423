import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { Download, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase, isSupabaseConfigured } from "@/integrations/supabase/client";

const BUCKET = "iv-platform-releases";
type Platform = "windows" | "android" | "ios";
type CurrentRelease = {
  id: string;
  platform: Platform;
  version: string;
  release_notes: string;
  download_url: string | null;
  artifact_path: string | null;
  file_name: string | null;
  published_at: string;
};
type NoticeRelease = CurrentRelease & { actionUrl: string };

function currentPlatform(): Platform | null {
  const userAgent = navigator.userAgent;
  if (/android/i.test(userAgent)) return "android";
  if (/(iphone|ipad|ipod)/i.test(userAgent)) return "ios";
  if (/(windows|win32)/i.test(userAgent)) return "windows";
  return null;
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function PlatformAppReleaseNotice({ enabled }: { enabled: boolean }) {
  const [release, setRelease] = useState<NoticeRelease | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const platform = currentPlatform();
    if (!enabled || !platform || !isSupabaseConfigured()) {
      setRelease(null);
      return;
    }

    const checkForRelease = async () => {
      if (inFlight || !navigator.onLine) return;
      inFlight = true;
      try {
        const { data, error } = await supabase.rpc("platform_current_app_releases");
        if (error) throw error;
        const latest = ((data ?? []) as CurrentRelease[]).find((item) => item.platform === platform);
        if (!latest) {
          if (active) setRelease(null);
          return;
        }

        if (isTauri()) {
          const installedVersion = await getVersion();
          if (compareVersions(latest.version, installedVersion) <= 0) {
            if (active) setRelease(null);
            return;
          }
        }

        if (sessionStorage.getItem(`ironvault.release.dismissed.${platform}`) === latest.id) {
          if (active) setRelease(null);
          return;
        }

        let actionUrl = latest.download_url ?? "";
        if (latest.artifact_path) {
          const { data: signed, error: signedError } = await supabase.storage
            .from(BUCKET)
            .createSignedUrl(latest.artifact_path, 24 * 60 * 60, {
              download: latest.file_name ?? true,
            });
          if (signedError) throw signedError;
          actionUrl = signed.signedUrl;
        }
        if (active && actionUrl) setRelease({ ...latest, actionUrl });
      } catch {
        // The release center is additive; a missing migration or a temporary
        // storage outage must never interrupt ordinary gym workspace access.
      } finally {
        inFlight = false;
      }
    };

    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForRelease();
    };
    const interval = window.setInterval(checkWhenVisible, 5 * 60 * 1000);
    window.addEventListener("online", checkWhenVisible);
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    void checkForRelease();

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("online", checkWhenVisible);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [enabled]);

  if (!release) return null;
  const isNative = isTauri();
  const heading =
    release.platform === "ios"
      ? `IRONVAULT for iOS v${release.version} is available`
      : release.platform === "android"
        ? `IRONVAULT for Android v${release.version} is available`
        : isNative
          ? `IRONVAULT v${release.version} update is ready`
          : `Windows app v${release.version} is available`;
  const actionLabel = release.platform === "ios" ? "Open App Store / TestFlight" : "Download update";

  return (
    <section role="status" aria-label="App update available" className="mb-5 rounded-xl border border-gold/35 bg-gold/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-semibold text-gold">{heading}</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{release.release_notes}</p>
          {release.platform === "ios" && (
            <p className="mt-1 text-xs text-muted-foreground">iOS installations and updates are handled by Apple through the linked store or TestFlight page.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild size="sm">
            <a href={release.actionUrl} target="_blank" rel="noopener noreferrer">
              {release.platform === "ios" ? <ExternalLink className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
              {actionLabel}
            </a>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Dismiss app update notice"
            onClick={() => {
              sessionStorage.setItem(`ironvault.release.dismissed.${release.platform}`, release.id);
              setRelease(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
