import { supabase } from "../../integrations/supabase/client";
import { getCloudGymContext, recordCloudAuditEvent } from "./cloud";

export const PRIVATE_ASSET_BUCKET = "ironvault-private";
export type PrivateAssetKind = "members" | "expenses";

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function isDirectAssetSource(value?: string | null) {
  return Boolean(value && /^(?:data:|blob:|https?:\/\/)/i.test(value));
}

export async function dataUrlToBlob(dataUrl: string) {
  if (!dataUrl.startsWith("data:")) throw new Error("Expected an inline file.");
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("The selected file could not be prepared for upload.");
  const metadata = dataUrl.slice(5, separator);
  const mimeType = metadata.split(";")[0] || "application/octet-stream";
  const payload = dataUrl.slice(separator + 1);
  try {
    const bytes = metadata.toLowerCase().includes(";base64")
      ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return new Blob([bytes], { type: mimeType });
  } catch {
    throw new Error("The selected file could not be prepared for upload.");
  }
}

function safeExtension(blob: Blob, filename?: string) {
  const byMime = MIME_EXTENSION[blob.type.toLowerCase()];
  if (byMime) return byMime;
  const byName = filename?.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (byName && byName.length <= 8) return byName;
  throw new Error("This file type is not supported.");
}

export async function uploadPrivateAsset(
  kind: PrivateAssetKind,
  blob: Blob,
  filename?: string,
) {
  const context = await getCloudGymContext();
  if (!context?.gymId || !context.enabled) throw new Error("Your gym session is not active.");
  const extension = safeExtension(blob, filename);
  const path = `${context.gymId}/${kind}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(PRIVATE_ASSET_BUCKET).upload(path, blob, {
    cacheControl: "3600",
    contentType: blob.type || undefined,
    upsert: false,
  });
  if (error) throw new Error("The private file could not be uploaded. Please try again.");
  await recordCloudAuditEvent("storage_uploaded", kind, path, {
    content_type: blob.type || null,
    size: blob.size,
  }).catch(() => undefined);
  return path;
}

export async function privateAssetUrl(source?: string | null, expiresIn = 300) {
  if (!source) return null;
  if (isDirectAssetSource(source)) return source;
  const { data, error } = await supabase.storage
    .from(PRIVATE_ASSET_BUCKET)
    .createSignedUrl(source, Math.max(30, Math.min(expiresIn, 3600)));
  if (error || !data?.signedUrl) throw new Error("The private file could not be opened.");
  return data.signedUrl;
}

export async function deletePrivateAsset(source?: string | null) {
  if (!source || isDirectAssetSource(source)) return;
  const { error } = await supabase.storage.from(PRIVATE_ASSET_BUCKET).remove([source]);
  if (error) throw new Error("The private file could not be removed.");
  await recordCloudAuditEvent("storage_deleted", "private_asset", source).catch(() => undefined);
}
