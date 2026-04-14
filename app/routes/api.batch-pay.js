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
      const { paymentMethodId, amount, attempt, sessionId } = body;

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

      const CONCURRENCY = 10;
      const results = [];
      for (let i = 0; i < allocations.length; i += CONCURRENCY) {
        const batch = allocations.slice(i, i + CONCURRENCY);
        const promises = batch.map((alloc) => {
          const order = info.orders.find((o) => o.id === alloc.orderId);
          return payOneOrder({
            admin,
            orderId: alloc.orderId,
            orderName: order?.name,
            mandateId: paymentMethodId,
            amount: alloc.applied,
            currencyCode: info.currencyCode,
            companyLocationId: locationInfo.companyLocationId,
            attempt: attemptNum,
            sessionId: sessionId || "x",
            outstandingBefore: order?.outstanding,
          });
        });
        const settled = await Promise.allSettled(promises);
        for (let j = 0; j < settled.length; j++) {
          const s = settled[j];
          const alloc = batch[j];
          results.push(
            s.status === "fulfilled"
              ? s.value
              : {
                  orderId: alloc.orderId,
                  name: info.orders.find((o) => o.id === alloc.orderId)?.name,
                  applied: alloc.applied,
                  status: "failed",
                  error: s.reason?.message || "Unexpected error",
                },
          );
        }
      }

      const allocatedTotal = allocations
        .reduce((s, a) => s + parseFloat(a.applied), 0)
        .toFixed(2);

      // Optimistic metafield writeback
      // ARIES will authoritatively set these later, but update now for immediate rep feedback
      const successTotal = results
        .filter((r) => r.status === "success")
        .reduce((s, r) => s + parseFloat(r.applied), 0);

      if (successTotal > 0) {
        try {
          const customerGid = buyerCustomerId?.toString().startsWith("gid://")
            ? buyerCustomerId
            : `gid://shopify/Customer/${buyerCustomerId}`;

          // Read current metafield values
          const metaResponse = await admin.graphql(
            `#graphql
            query GetCustomerBalanceMetafields($id: ID!) {
              customer(id: $id) {
                accountBalance: metafield(namespace: "custom", key: "account_balance") { value }
                overdueBalance: metafield(namespace: "custom", key: "overdue_balance") { value }
                availableCredit: metafield(namespace: "custom", key: "available_credit") { value }
                creditLimit: metafield(namespace: "custom", key: "credit_limit") { value }
              }
            }`,
            { variables: { id: customerGid } },
          );
          const metaData = await metaResponse.json();
          const customer = metaData.data?.customer;

          const currentBalance = parseFloat(customer?.accountBalance?.value || "0");
          const currentOverdue = parseFloat(customer?.overdueBalance?.value || "0");
          const currentCredit = parseFloat(customer?.availableCredit?.value || "0");
          const creditLimit = parseFloat(customer?.creditLimit?.value || "0");

          // Optimistic: ARIES will authoritatively correct these within minutes.
          // overdue formula works because allocation is oldest-due-first (overdue orders paid before non-overdue).
          // Race condition possible if two reps pay simultaneously — ARIES resolves.
          const newBalance = Math.max(0, currentBalance - successTotal).toFixed(2);
          const newOverdue = Math.max(0, currentOverdue - successTotal).toFixed(2);
          const newCredit = creditLimit > 0
            ? Math.min(creditLimit, currentCredit + successTotal).toFixed(2)
            : (currentCredit + successTotal).toFixed(2);

          const metafields = [
            { ownerId: customerGid, namespace: "custom", key: "account_balance", type: "number_decimal", value: newBalance },
            { ownerId: customerGid, namespace: "custom", key: "overdue_balance", type: "number_decimal", value: newOverdue },
            { ownerId: customerGid, namespace: "custom", key: "available_credit", type: "number_decimal", value: newCredit },
          ];

          await admin.graphql(
            `#graphql
            mutation SetBalanceMetafields($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id }
                userErrors { field message }
              }
            }`,
            { variables: { metafields } },
          );
          console.log("Optimistic metafield update:", { newBalance, newOverdue, newCredit });
        } catch (metaError) {
          // Don't fail the payment response if metafield update fails
          console.error("Metafield optimistic update failed:", metaError.message);
        }
      }

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
  // Paginate through all orders for the company location
  let allNodes = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query GetCompanyLocationOpenOrders($id: ID!, $cursor: String) {
        companyLocation(id: $id) {
          id
          currency
          orders(first: 250, after: $cursor, sortKey: PROCESSED_AT, reverse: false) {
            edges {
              node {
                id
                name
                processedAt
                displayFinancialStatus
                totalOutstandingSet { shopMoney { amount currencyCode } }
                paymentTerms {
                  paymentSchedules(first: 1) {
                    nodes { dueAt }
                  }
                }
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
              cursor
            }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { variables: { id: locationInfo.companyLocationId, cursor } },
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
    const edges = loc.orders?.edges || [];
    allNodes.push(...edges.map((e) => e.node));
    hasNextPage = loc.orders?.pageInfo?.hasNextPage || false;
    if (edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    } else {
      hasNextPage = false;
    }
  }

  const now = new Date();
  let currencyCode = locationInfo.currency;
  let aggregatedMethods = new Map();

  const rawOrders = allNodes
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
      // Use paymentTerms.paymentSchedules dueAt; fall back to processedAt
      const scheduleDueAt = o.paymentTerms?.paymentSchedules?.nodes?.[0]?.dueAt;
      const dueAt = scheduleDueAt || o.processedAt;
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
  sessionId,
  outstandingBefore,
}) {
  const idempotencyKey = makeIdempotencyKey(orderId, attempt, sessionId);

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

    // Verify: re-query order outstanding to confirm payment actually applied
    const verifyResponse = await admin.graphql(
      `#graphql
      query VerifyPayment($orderId: ID!) {
        order(id: $orderId) {
          totalOutstandingSet { shopMoney { amount } }
        }
      }`,
      { variables: { orderId } },
    );
    const verifyData = await verifyResponse.json();
    const remainingOutstanding = verifyData.data?.order?.totalOutstandingSet?.shopMoney?.amount || "0";
    const before = parseFloat(outstandingBefore || "0");
    const after = parseFloat(remainingOutstanding);

    // If outstanding didn't decrease, the payment silently failed
    if (before > 0 && after >= before) {
      return {
        orderId,
        name: orderName,
        applied: amount,
        status: "failed",
        remainingOutstanding,
        error: "Payment was processed but balance did not decrease. The selected card may have been declined.",
      };
    }

    return {
      orderId,
      name: orderName,
      applied: amount,
      status: "success",
      remainingOutstanding,
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

function makeIdempotencyKey(orderId, attempt, sessionId) {
  // Deterministic within a session+attempt: same click = same key = Shopify dedupes (double-click safe).
  // New session (re-open widget) = new sessionId = new key = fresh attempt (avoids stale cache).
  const ordNum = (orderId.match(/\d+$/) || ["0"])[0];
  const raw = `${ordNum}_${attempt}_${sessionId}`;
  return raw.slice(0, 32);
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
