import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, Download, LoaderCircle, PackageCheck, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, EmptyState } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "iv-platform-releases";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
type Platform = "windows" | "android" | "ios";
type Release = {
  id: string;
  platform: Platform;
  version: string;
  release_notes: string;
  download_url: string | null;
  artifact_path: string | null;
  file_name: string | null;
  status: "published" | "archived";
  created_at: string;
  published_at: string;
};

const platformLabel: Record<Platform, string> = {
  windows: "Windows",
  android: "Android",
  ios: "iOS",
};

function safeFileName(value: string) {
  return (value.split(/[\\/]/).pop() ?? "release")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(-160);
}

function isVersion(value: string) {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.trim());
}

function iosDistributionUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "apps.apple.com" || url.hostname === "testflight.apple.com")
    );
  } catch {
    return false;
  }
}

function fileMatches(platform: Platform, file: File | null) {
  if (!file || file.size <= 0 || file.size > MAX_FILE_BYTES) return false;
  const name = file.name.toLowerCase();
  return platform === "windows"
    ? name.endsWith(".exe") || name.endsWith(".msi")
    : platform === "android"
      ? name.endsWith(".apk")
      : false;
}

function readableError(error: unknown) {
  const message = (error as { message?: string })?.message ?? "";
  if (message.includes("APP_RELEASE_STATUS_UNKNOWN")) {
    return "Publish status is uncertain. Refresh release history before retrying; any uploaded installer was kept safe.";
  }
  if (message.includes("PLATFORM_ADMIN_REQUIRED")) return "Only a CEO platform administrator can manage releases.";
  if (message.includes("APP_RELEASE_VERSION_EXISTS")) return "That platform version has already been published or archived.";
  if (message.includes("APP_RELEASE_ARTIFACT_NOT_FOUND")) return "The uploaded installer could not be verified. Retry the upload.";
  if (message.includes("INVALID_IOS_DISTRIBUTION_LINK")) return "Use an official HTTPS App Store or TestFlight link for iOS.";
  if (message.includes("INVALID_WINDOWS_APP_ARTIFACT")) return "Choose a Windows .exe or .msi installer.";
  if (message.includes("INVALID_ANDROID_APP_ARTIFACT")) return "Choose an Android .apk installer.";
  if (message.includes("INVALID_APP_VERSION")) return "Use a version in major.minor.patch format, such as 1.2.0.";
  if (message.includes("APP_RELEASE_NOT_FOUND")) return "That release is no longer available. Refresh the list.";
  return "The release operation failed. Check your connection and try again.";
}

function isDefinitivePublishRejection(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  // The publish RPC raises P0001 for validated failures and translates its
  // uniqueness violation to P0001. Transport/server failures remain ambiguous.
  return code === "P0001";
}

export function PlatformReleaseCenter() {
  const [platform, setPlatform] = useState<Platform>("windows");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [iosUrl, setIosUrl] = useState("");
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadReleases = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("platform_list_app_releases");
      if (error) throw error;
      setReleases((data ?? []) as Release[]);
    } catch (error) {
      toast.error(readableError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReleases();
  }, [loadReleases]);

  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedVersion = version.trim();
    const normalizedNotes = notes.trim();
    if (!isVersion(normalizedVersion)) {
      toast.error("Enter a version in major.minor.patch format, such as 1.2.0.");
      return;
    }
    if (!normalizedNotes || normalizedNotes.length > 4000) {
      toast.error("Release notes are required and must be 4,000 characters or fewer.");
      return;
    }
    if (platform === "ios" && !iosDistributionUrl(iosUrl.trim())) {
      toast.error("Use an official HTTPS App Store or TestFlight URL for iOS.");
      return;
    }
    if (platform !== "ios" && !fileMatches(platform, file)) {
      toast.error(
        platform === "windows"
          ? "Choose a Windows .exe or .msi file smaller than 50 MB."
          : "Choose an Android .apk file smaller than 50 MB.",
      );
      return;
    }

    setBusy(true);
    let uploadedPath: string | null = null;
    let preserveUploadedArtifact = false;
    try {
      if (platform !== "ios" && file) {
        const extension = file.name.split(".").pop()?.toLowerCase();
        if (!extension || !["exe", "msi", "apk"].includes(extension)) {
          throw new Error(platform === "windows" ? "INVALID_WINDOWS_APP_ARTIFACT" : "INVALID_ANDROID_APP_ARTIFACT");
        }
        uploadedPath = `${platform}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(uploadedPath, file, {
          cacheControl: "3600",
          contentType: "application/octet-stream",
          upsert: false,
        });
        if (uploadError) throw uploadError;
      }

      let publishResult: Awaited<ReturnType<typeof supabase.rpc>>;
      try {
        publishResult = await supabase.rpc("platform_publish_app_release", {
          p_platform: platform,
          p_version: normalizedVersion,
          p_release_notes: normalizedNotes,
          p_artifact_path: uploadedPath,
          p_file_name: platform === "ios" ? null : safeFileName(file?.name ?? ""),
          p_download_url: platform === "ios" ? iosUrl.trim() : null,
        });
      } catch {
        // A rejected fetch can mean the server committed but its reply was lost.
        preserveUploadedArtifact = Boolean(uploadedPath);
        throw new Error("APP_RELEASE_STATUS_UNKNOWN");
      }

      if (publishResult.error) {
        let matchingRelease: Release | undefined;
        let reconciliationFailed = false;
        try {
          const { data, error: listError } = await supabase.rpc("platform_list_app_releases");
          reconciliationFailed = Boolean(listError);
          matchingRelease = (data as Release[] | null)?.find((release) =>
            release.platform === platform &&
            release.version === normalizedVersion &&
            (platform === "ios"
              ? release.download_url === iosUrl.trim()
              : release.artifact_path === uploadedPath),
          );
        } catch {
          reconciliationFailed = true;
        }

        if (matchingRelease) {
          // The publish committed despite the lost/failed response. The release
          // row now owns this object; never remove it as error cleanup.
          uploadedPath = null;
        } else if (reconciliationFailed || !isDefinitivePublishRejection(publishResult.error)) {
          preserveUploadedArtifact = Boolean(uploadedPath);
          throw new Error("APP_RELEASE_STATUS_UNKNOWN");
        } else {
          throw publishResult.error;
        }
      } else {
        // From this point the database row references the uploaded object.
        uploadedPath = null;
      }

      toast.success(`${platformLabel[platform]} ${normalizedVersion} published to gym workspaces.`);
      setVersion("");
      setNotes("");
      setFile(null);
      setIosUrl("");
      const input = document.getElementById("release-artifact") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadReleases();
    } catch (error) {
      if (uploadedPath && !preserveUploadedArtifact) {
        await supabase.storage.from(BUCKET).remove([uploadedPath]).catch(() => undefined);
      }
      toast.error(readableError(error));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (release: Release) => {
    if (!window.confirm(`Archive ${platformLabel[release.platform]} ${release.version}? New app sessions will no longer receive this release.`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("platform_archive_app_release", { p_release_id: release.id });
      if (error) throw error;
      toast.success("Release archived. Its history and file are preserved.");
      await loadReleases();
    } catch (error) {
      toast.error(readableError(error));
    } finally {
      setBusy(false);
    }
  };

  const download = async (release: Release) => {
    if (release.download_url) {
      window.open(release.download_url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!release.artifact_path) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(release.artifact_path, 3600);
      if (error || !data?.signedUrl) throw error ?? new Error("Signed download link unavailable.");
      const anchor = document.createElement("a");
      anchor.href = data.signedUrl;
      anchor.download = release.file_name ?? "ironvault-release";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
    } catch (error) {
      toast.error(readableError(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedFileHelp =
    platform === "windows"
      ? "Signed .exe or .msi installer · up to 50 MB"
      : "Signed Android .apk · up to 50 MB";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform release center"
        subtitle="Publish signed Windows and Android installers and official iOS distribution links to gym workspaces."
        actions={
          <Button variant="secondary" onClick={() => void loadReleases()} disabled={loading || busy}>
            {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh releases
          </Button>
        }
      />

      <Panel title="Publish an app release" description="Published builds are announced inside the matching gym app after the next online check.">
        <div role="note" className="mb-5 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm leading-6 text-muted-foreground">
          Upload installers that have already been built and independently verified. This center distributes files; it does not compile them, verify code signatures, silently install them, or bypass store review. iOS must use an App Store or TestFlight link.
        </div>
        <form onSubmit={(event) => void publish(event)} className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="release-platform">Platform</Label>
            <Select value={platform} onValueChange={(value) => { setPlatform(value as Platform); setFile(null); setIosUrl(""); }}>
              <SelectTrigger id="release-platform"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="windows">Windows installer</SelectItem>
                <SelectItem value="android">Android APK</SelectItem>
                <SelectItem value="ios">iOS App Store / TestFlight</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-version">Version</Label>
            <Input id="release-version" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.2.0" pattern="[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}" required />
          </div>
          {platform === "ios" ? (
            <div key="ios-distribution-link" className="space-y-2 md:col-span-2">
              <Label htmlFor="release-ios-url">App Store or TestFlight URL</Label>
              <Input id="release-ios-url" type="url" value={iosUrl} onChange={(event) => setIosUrl(event.target.value)} placeholder="https://apps.apple.com/..." required />
              <p className="text-xs text-muted-foreground">For TestFlight, use the public or invited tester link. Uploading an IPA here cannot install it on iPhones.</p>
            </div>
          ) : (
            <div key="native-installer-file" className="space-y-2 md:col-span-2">
              <Label htmlFor="release-artifact">{platformLabel[platform]} installer</Label>
              <Input
                id="release-artifact"
                type="file"
                accept={platform === "windows" ? ".exe,.msi,application/octet-stream" : ".apk,application/vnd.android.package-archive"}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                required
              />
              <p className="text-xs text-muted-foreground">{selectedFileHelp}{file ? ` · Selected: ${safeFileName(file.name)} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : ""}</p>
            </div>
          )}
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="release-notes">Release notes</Label>
            <Textarea id="release-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} rows={4} placeholder="Describe the important fixes or changes in this release." required />
            <p className="text-right text-xs text-muted-foreground">{notes.length}/4,000</p>
          </div>
          <div className="flex justify-end md:col-span-2">
            <Button type="submit" disabled={busy || loading}>
              {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {busy ? "Publishing…" : "Publish release"}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title="Release history" description="The newest published version for each supported platform is announced to matching gym users.">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading release history…</div>
        ) : releases.length === 0 ? (
          <EmptyState title="No app releases yet" hint="Publish a signed Windows installer, Android APK, or official iOS distribution link above." />
        ) : (
          <div className="space-y-3">
            {releases.map((release) => (
              <article key={release.id} className="flex flex-col gap-4 rounded-xl border border-border bg-secondary/10 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PackageCheck className="h-4 w-4 text-gold" />
                    <h3 className="font-semibold">{platformLabel[release.platform]} · v{release.version}</h3>
                    <span className={release.status === "published" ? "rounded-full border border-success/35 px-2 py-0.5 text-xs text-success" : "rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"}>{release.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Published {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(release.published_at))}{release.file_name ? ` · ${release.file_name}` : ""}</p>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{release.release_notes}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => void download(release)} disabled={busy}>
                    <Download className="mr-2 h-4 w-4" /> {release.platform === "ios" ? "Open distribution" : "Download"}
                  </Button>
                  {release.status === "published" && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void archive(release)} disabled={busy} aria-label={`Archive ${release.platform} version ${release.version}`}>
                      <Archive className="mr-2 h-4 w-4" /> Archive
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
