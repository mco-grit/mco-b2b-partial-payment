import { authenticate, unauthenticated } from "../shopify.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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
    const buyerCustomerId = auth.sessionToken.sub;

    const { admin } = await unauthenticated.admin(shopDomain);

    const body = await request.clone().json();
    const { op } = body;

    // Resolve company location for this buyer
    const locationInfo = await resolveCompanyLocation(admin, buyerCustomerId);
    if (!locationInfo) {
      return jsonResponse({ error: "No company location for this buyer" }, 404, corsHeaders);
    }

    if (op === "get-info") {
      const info = await fetchOpenOrdersAndMethods(admin, locationInfo);
      return jsonResponse(info, 200, corsHeaders);
    }

    if (op === "pay") {
      const { paymentMethodId, amount, attempt } = body;

      if (!paymentMethodId) {
        return jsonResponse({ error: "Missing paymentMethodId" }, 400, corsHeaders);
      }
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return jsonResponse({ error: "Amount must be a positive number" }, 400, corsHeaders);
      }
      const attemptNum = parseInt(attempt, 10) || 1;

      // Re-fetch authoritative order list (do not trust client)
      const info = await fetchOpenOrdersAndMethods(admin, locationInfo);
      const allocations = allocate(info.orders, parsedAmount);

      const results = [];
      for (const alloc of allocations) {
        const order = info.orders.find((o) => o.id === alloc.orderId);
        const result = await payOneOrder({
          admin,
          orderId: alloc.orderId,
          orderName: order?.name,
          mandateId: paymentMethodId,
          amount: alloc.applied,
          currencyCode: info.currencyCode,
          companyLocationId: locationInfo.companyLocationId,
          attempt: attemptNum,
        });
        results.push(result);
      }

      const allocatedTotal = allocations
        .reduce((s, a) => s + parseFloat(a.applied), 0)
        .toFixed(2);

      return jsonResponse(
        {
          requestedAmount: parsedAmount.toFixed(2),
          allocatedAmount: allocatedTotal,
          results,
        },
        200,
        corsHeaders,
      );
    }

    return jsonResponse({ error: "Unknown op" }, 400, corsHeaders);
  } catch (error) {
    console.error("Batch pay error:", error);
    return jsonResponse({ error: error.message || "Internal server error" }, 500, corsHeaders);
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

// --- Helpers ---

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

async function resolveCompanyLocation(admin, customerId) {
  // customerId from session token sub is a numeric id; build a gid
  const gid = customerId?.toString().startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  const response = await admin.graphql(
    `#graphql
    query GetBuyerCompanyLocation($id: ID!) {
      customer(id: $id) {
        id
        companyContactProfiles {
          company { id name }
          roleAssignments(first: 10) {
            edges {
              node {
                companyLocation {
                  id
                  name
                  currency
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { id: gid } },
  );
  const data = await response.json();
  const profile = data.data?.customer?.companyContactProfiles?.[0];
  const edge = profile?.roleAssignments?.edges?.[0];
  const loc = edge?.node?.companyLocation;
  if (!loc) return null;
  return {
    companyLocationId: loc.id,
    companyId: profile.company.id,
    currency: loc.currency,
  };
}

async function fetchOpenOrdersAndMethods(admin, locationInfo) {
  // Fetch open orders for the company location
  const response = await admin.graphql(
    `#graphql
    query GetCompanyLocationOpenOrders($id: ID!) {
      companyLocation(id: $id) {
        id
        currency
        orders(first: 100, sortKey: PROCESSED_AT, reverse: false) {
          edges {
            node {
              id
              name
              processedAt
              displayFinancialStatus
              totalOutstandingSet { shopMoney { amount currencyCode } }
              paymentCollectionDetails {
                vaultedPaymentMethods {
                  id
                  paymentInstrument {
                    ... on VaultCreditCard {
                      brand lastDigits name expiryMonth expiryYear expired
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { id: locationInfo.companyLocationId } },
  );
  const data = await response.json();
  const loc = data.data?.companyLocation;
  if (!loc) {
    return {
      companyLocationId: locationInfo.companyLocationId,
      currencyCode: locationInfo.currency,
      totalOutstanding: "0.00",
      overdueOutstanding: "0.00",
      orders: [],
      paymentMethods: [],
    };
  }

  const now = new Date();
  let currencyCode = locationInfo.currency;
  let aggregatedMethods = new Map();

  const rawOrders = (loc.orders?.edges || [])
    .map((e) => e.node)
    .filter((o) => parseFloat(o.totalOutstandingSet?.shopMoney?.amount || "0") > 0)
    .map((o) => {
      const outstanding = o.totalOutstandingSet.shopMoney.amount;
      currencyCode = o.totalOutstandingSet.shopMoney.currencyCode || currencyCode;
      // Aggregate vaulted methods across orders (one card for batch)
      (o.paymentCollectionDetails?.vaultedPaymentMethods || []).forEach((m) => {
        if (!aggregatedMethods.has(m.id)) {
          aggregatedMethods.set(m.id, {
            id: m.id,
            brand: m.paymentInstrument?.brand,
            lastDigits: m.paymentInstrument?.lastDigits,
            name: m.paymentInstrument?.name,
            expiryMonth: m.paymentInstrument?.expiryMonth,
            expiryYear: m.paymentInstrument?.expiryYear,
            expired: m.paymentInstrument?.expired,
          });
        }
      });
      // paymentTerms.nextDueAt isn't a real field — placeholder; fall back to processedAt
      const dueAt = o.processedAt;
      const overdue = dueAt ? new Date(dueAt) < now : false;
      return {
        id: o.id,
        name: o.name,
        dueAt,
        outstanding,
        overdue,
      };
    })
    .sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });

  const totalOutstanding = rawOrders
    .reduce((s, o) => s + parseFloat(o.outstanding), 0)
    .toFixed(2);
  const overdueOutstanding = rawOrders
    .filter((o) => o.overdue)
    .reduce((s, o) => s + parseFloat(o.outstanding), 0)
    .toFixed(2);

  return {
    companyLocationId: locationInfo.companyLocationId,
    currencyCode,
    totalOutstanding,
    overdueOutstanding,
    orders: rawOrders,
    paymentMethods: Array.from(aggregatedMethods.values()),
  };
}

export function allocate(orders, requestedAmount) {
  const totalOutstanding = orders.reduce(
    (s, o) => s + parseFloat(o.outstanding),
    0,
  );
  let remaining = Math.min(requestedAmount, totalOutstanding);
  const allocations = [];
  for (const o of orders) {
    if (remaining <= 0.0001) break;
    const outstanding = parseFloat(o.outstanding);
    const applied = Math.min(outstanding, remaining);
    if (applied > 0) {
      allocations.push({ orderId: o.id, applied: applied.toFixed(2) });
      remaining -= applied;
    }
  }
  return allocations;
}

async function payOneOrder({
  admin,
  orderId,
  orderName,
  mandateId,
  amount,
  currencyCode,
  companyLocationId,
  attempt,
}) {
  // Idempotency key — must be <=32 chars. Hash the parts.
  const idempotencyKey = makeIdempotencyKey(companyLocationId, orderId, attempt);

  const callMutation = async () => {
    const response = await admin.graphql(
      `#graphql
      mutation OrderCreateMandatePayment(
        $id: ID!
        $mandateId: ID!
        $amount: MoneyInput!
        $idempotencyKey: String!
      ) {
        orderCreateMandatePayment(
          id: $id
          mandateId: $mandateId
          idempotencyKey: $idempotencyKey
          amount: $amount
          autoCapture: true
        ) {
          job { id done }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          id: orderId,
          mandateId,
          idempotencyKey,
          amount: { amount, currencyCode },
        },
      },
    );
    return response.json();
  };

  let attemptResult;
  try {
    attemptResult = await callMutation();
    let mutation = attemptResult.data?.orderCreateMandatePayment;
    if (mutation?.userErrors?.length) {
      // Retry once with same idempotency key
      attemptResult = await callMutation();
      mutation = attemptResult.data?.orderCreateMandatePayment;
      if (mutation?.userErrors?.length) {
        return {
          orderId,
          name: orderName,
          applied: amount,
          status: "failed",
          retried: true,
          error: mutation.userErrors.map((e) => e.message).join("; "),
        };
      }
    }
    const job = mutation?.job;
    if (!job) {
      return {
        orderId,
        name: orderName,
        applied: amount,
        status: "failed",
        error: "No job returned",
      };
    }
    const polled = await pollJob(admin, job.id);
    if (!polled.done) {
      return {
        orderId,
        name: orderName,
        applied: amount,
        status: "pending",
        jobId: job.id,
      };
    }
    return {
      orderId,
      name: orderName,
      applied: amount,
      status: "success",
    };
  } catch (e) {
    return {
      orderId,
      name: orderName,
      applied: amount,
      status: "failed",
      error: e.message,
    };
  }
}

function makeIdempotencyKey(companyLocationId, orderId, attempt) {
  // Extract numeric ids and combine. Cap at 32 chars.
  const locNum = (companyLocationId.match(/\d+$/) || ["0"])[0];
  const ordNum = (orderId.match(/\d+$/) || ["0"])[0];
  const raw = `b${locNum}o${ordNum}a${attempt}`;
  return raw.length > 32 ? raw.slice(0, 32) : raw;
}

async function pollJob(admin, jobId, maxAttempts = 10, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await admin.graphql(
      `#graphql
      query GetJob($jobId: ID!) {
        job(id: $jobId) { id done }
      }`,
      { variables: { jobId } },
    );
    const data = await response.json();
    const job = data.data?.job;
    if (!job) return { done: false, error: "Job not found" };
    if (job.done) return { done: true };
  }
  return { done: false };
}
