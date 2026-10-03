import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { privateAssetUrl } from "@/lib/gym/storage";

export function usePrivateAssetUrl(source?: string | null) {
  const [url, setUrl] = useState<string | null>(() =>
    source && /^(?:data:|blob:|https?:\/\/)/i.test(source) ? source : null,
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
    if (!source) {
      setUrl(null);
      return () => {
        active = false;
      };
    }
    if (/^(?:data:|blob:|https?:\/\/)/i.test(source)) {
      setUrl(source);
      return () => {
        active = false;
      };
    }
    setUrl(null);
    void privateAssetUrl(source)
      .then((signed) => {
        if (active) setUrl(signed);
      })
      .catch(() => {
        if (active) {
          setUrl(null);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [source]);

  return { url, error };
}

export function PrivateAssetImage({
  source,
  fallback = null,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  source?: string | null;
  fallback?: ReactNode;
}) {
  const { url } = usePrivateAssetUrl(source);
  if (!url) return <>{fallback}</>;
  return <img {...props} src={url} />;
}
