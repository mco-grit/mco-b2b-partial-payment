import { useRef, useState, useCallback, useEffect } from "preact/hooks";

/**
 * Translation resolution for the order-pay extensions. Mirrors the mco-avon-rep
 * pattern: the "rep_dashboard_translations" metaobject (managed in Translate &
 * Adapt) is the primary source, with the extension's bundled locale JSON as the
 * offline fallback. Placeholders use [bracket] syntax to match the metaobject
 * convention; we interpolate them ourselves.
 */

export function resolveLocale() {
  try {
    const iso = shopify?.localization?.language?.current?.isoCode || "";
    return iso.split("-")[0].toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

export async function fetchTranslations(appUrl, token, locale) {
  try {
    const res = await fetch(`${appUrl}/api/translations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ locale }),
    });
    const data = await res.json();
    return data?.translations || null;
  } catch (_) {
    return null;
  }
}

function interpolate(str, vars) {
  if (!vars) return str;
  return String(str).replace(/\[(\w+)\]/g, (m, k) =>
    vars[k] != null ? String(vars[k]) : m,
  );
}

/**
 * Hook returning a stable `t(key, vars)`:
 *   metaobject value -> bundled i18n JSON -> raw key, then [var] interpolation.
 * Fetches the metaobject map once on mount; until it loads, the JSON fallback is
 * used, so the UI never blocks on the network.
 */
export function useTranslations(appUrl, getToken) {
  const mapRef = useRef(null);
  const [, bump] = useState(0);

  const t = useCallback((key, vars) => {
    const mo = mapRef.current;
    let s =
      mo && mo[key] != null && mo[key] !== "" ? mo[key] : null;
    if (s == null) {
      try {
        s = shopify.i18n.translate(key);
      } catch (_) {
        s = key;
      }
    }
    return interpolate(s, vars);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await getToken();
        const map = await fetchTranslations(appUrl, token, resolveLocale());
        if (active && map) {
          mapRef.current = map;
          bump((v) => v + 1);
        }
      } catch (_) {
        // keep falling back to bundled JSON
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return t;
}
