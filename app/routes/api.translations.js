import { authenticate, unauthenticated } from "../shopify.server";

/**
 * Returns translations from the "rep_dashboard_translations" metaobject as a flat
 * { key: value } map. Mirrors mco-avon-rep's app/routes/api.translations.tsx, but
 * authenticates via the customer-account session (deriving the shop from the token's
 * dest) instead of a shop query param.
 *
 * POST /api/translations  body: { locale?: "fr" }
 * Base values are English; when a locale is given, Translate & Adapt translations of
 * the "value" field are overlaid. On any error it returns { translations: null } with
 * 200 so the extension silently falls back to its bundled locale JSON.
 */

const METAOBJECT_TYPE = "rep_dashboard_translations";
// The metaobject is shared across rep-facing apps; this extension only needs its
// own namespace, so we filter to it (smaller payload + fewer translation queries).
const KEY_PREFIX = "partial_pay_";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // `${shop}:${locale}` -> { at, data }

export async function action({ request }) {
  const origin = request.headers.get("Origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    const auth = await authenticate.public.customerAccount(request);
    const dest = auth.sessionToken.dest;
    const shopDomain = dest.includes("://") ? new URL(dest).hostname : dest;

    let locale = null;
    try {
      const body = await request.clone().json();
      locale = body.locale ? String(body.locale).toLowerCase() : null;
    } catch (_) {
      // no body / no locale — base English only
    }

    const cacheKey = `${shopDomain}:${locale || "base"}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return jsonResponse(cached.data, 200, corsHeaders);
    }

    const { admin } = await unauthenticated.admin(shopDomain);

    // Page through all entries — the metaobject is shared with the rep dashboard
    // (~200 entries already), so a single first:250 page would soon truncate ours.
    const nodes = [];
    let currencyCode = "USD";
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const baseResp = await admin.graphql(
        `#graphql
        query GetTranslations($cursor: String) {
          metaobjects(type: "${METAOBJECT_TYPE}", first: 250, after: $cursor) {
            edges { cursor node { id fields { key value } } }
            pageInfo { hasNextPage }
          }
          shop { currencyCode }
        }`,
        { variables: { cursor } },
      );
      const baseData = await baseResp.json();
      const conn = baseData?.data?.metaobjects;
      currencyCode = baseData?.data?.shop?.currencyCode || currencyCode;
      const edges = conn?.edges || [];
      for (const e of edges) nodes.push(e.node);
      hasNextPage = conn?.pageInfo?.hasNextPage || false;
      cursor = edges.length ? edges[edges.length - 1].cursor : null;
      if (!cursor) hasNextPage = false;
    }

    // Build the base (English) map, keeping only this extension's namespace.
    const translations = {};
    const idToKey = {};
    for (const node of nodes) {
      let tKey = "";
      let tValue = "";
      for (const f of node.fields || []) {
        if (f.key === "key") tKey = f.value;
        if (f.key === "value") tValue = f.value;
      }
      if (tKey.startsWith(KEY_PREFIX)) {
        translations[tKey] = tValue;
        idToKey[node.id] = tKey;
      }
    }

    // Overlay locale translations of the "value" field (our entries only)
    if (locale) {
      const resourceIds = Object.keys(idToKey);
      for (let i = 0; i < resourceIds.length; i += 50) {
        const batch = resourceIds.slice(i, i + 50);
        const transResp = await admin.graphql(
          `#graphql
          query GetTranslatedResources($resourceIds: [ID!]!, $locale: String!) {
            translatableResourcesByIds(resourceIds: $resourceIds, first: 50) {
              edges {
                node {
                  resourceId
                  translations(locale: $locale) { key value }
                }
              }
            }
          }`,
          { variables: { resourceIds: batch, locale } },
        );
        const transData = await transResp.json();
        const transEdges =
          transData?.data?.translatableResourcesByIds?.edges || [];
        for (const te of transEdges) {
          const tKey = idToKey[te.node.resourceId];
          if (!tKey) continue;
          const valueTrans = te.node.translations?.find((t) => t.key === "value");
          if (valueTrans?.value) translations[tKey] = valueTrans.value;
        }
      }
    }

    const payload = { translations, currencyCode };
    cache.set(cacheKey, { at: Date.now(), data: payload });
    return jsonResponse(payload, 200, corsHeaders);
  } catch (error) {
    console.error("Translations error:", error);
    // 200 with null so the extension falls back to bundled JSON
    return jsonResponse({ translations: null, error: error.message }, 200, corsHeaders);
  }
}

export async function loader({ request }) {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
