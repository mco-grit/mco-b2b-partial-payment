import { authenticate, unauthenticated } from "../shopify.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Handle CORS
  const origin = request.headers.get("Origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    // Validate customer session token
    const auth = await authenticate.public.customerAccount(request);

    // Get shop domain from session token
    const dest = auth.sessionToken.dest;
    const shopDomain = dest.includes("://") ? new URL(dest).hostname : dest;

    // Get Admin API client using the app's offline access token (stored in PostgreSQL)
    const { admin } = await unauthenticated.admin(shopDomain);

    const body = await request.clone().json();
    const { orderId, action: requestAction } = body;

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId" }, 400, corsHeaders);
    }

    console.log("Pay invoice request:", { orderId, action: requestAction, shop: shopDomain });

    // Fetch order details - start with a simple query to test
    let orderData;
    try {
      const orderResponse = await admin.graphql(
        `#graphql
        query GetOrderPaymentDetails($orderId: ID!) {
          order(id: $orderId) {
            id
            name
            displayFinancialStatus
            totalOutstandingSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }`,
        { variables: { orderId } },
      );
      orderData = await orderResponse.json();
      console.log("Order API response:", JSON.stringify(orderData, null, 2));
    } catch (gqlError) {
      console.error("GraphQL query error:", gqlError.message);
      console.error("GraphQL error details:", JSON.stringify({
        graphQLErrors: gqlError.body?.errors,
        response: gqlError.response?.status,
      }, null, 2));
      return jsonResponse({ error: `GraphQL error: ${gqlError.message}` }, 500, corsHeaders);
    }

    if (orderData.data?.order == null) {
      return jsonResponse({ error: "Order not found" }, 404, corsHeaders);
    }

    const order = orderData.data.order;
    const outstandingMoney = order.totalOutstandingSet?.shopMoney;

    // --- GET INFO ---
    if (requestAction === "get-info") {
      // Also fetch vaulted payment methods with card details
      let paymentMethods = [];
      try {
        const vaultedResponse = await admin.graphql(
          `#graphql
          query GetVaultedPaymentMethods($orderId: ID!) {
            order(id: $orderId) {
              paymentCollectionDetails {
                vaultedPaymentMethods {
                  id
                  paymentInstrument {
                    ... on VaultCreditCard {
                      brand
                      lastDigits
                      name
                      expiryMonth
                      expiryYear
                      expired
                    }
                  }
                }
              }
            }
          }`,
          { variables: { orderId } },
        );
        const vaultedData = await vaultedResponse.json();
        paymentMethods = (vaultedData.data?.order?.paymentCollectionDetails?.vaultedPaymentMethods || [])
          .map((m) => ({
            id: m.id,
            brand: m.paymentInstrument?.brand,
            lastDigits: m.paymentInstrument?.lastDigits,
            name: m.paymentInstrument?.name,
            expiryMonth: m.paymentInstrument?.expiryMonth,
            expiryYear: m.paymentInstrument?.expiryYear,
            expired: m.paymentInstrument?.expired,
          }));
      } catch (e) {
        console.error("Failed to fetch payment methods in get-info:", e.message);
      }

      return jsonResponse({
        order: {
          id: order.id,
          name: order.name,
          financialStatus: order.displayFinancialStatus,
          outstandingAmount: outstandingMoney?.amount || "0",
          currencyCode: outstandingMoney?.currencyCode || "GBP",
          paymentMethods,
        },
      }, 200, corsHeaders);
    }

    // --- PAY ---
    const { amount, currencyCode, mandateId: selectedMandateId } = body;

    if (!amount || !currencyCode) {
      return jsonResponse({ error: "Missing required fields: amount, currencyCode" }, 400, corsHeaders);
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return jsonResponse({ error: "Amount must be a positive number" }, 400, corsHeaders);
    }

    // Fetch vaulted payment methods separately
    let vaultedMethods = [];
    try {
      const vaultedResponse = await admin.graphql(
        `#graphql
        query GetVaultedPaymentMethods($orderId: ID!) {
          order(id: $orderId) {
            paymentCollectionDetails {
              vaultedPaymentMethods {
                id
              }
            }
          }
        }`,
        { variables: { orderId } },
      );
      const vaultedData = await vaultedResponse.json();
      vaultedMethods = vaultedData.data?.order?.paymentCollectionDetails?.vaultedPaymentMethods || [];
      console.log("Vaulted payment methods:", JSON.stringify(vaultedMethods, null, 2));
    } catch (vaultedError) {
      console.error("Vaulted payment methods query error:", vaultedError.message);
      return jsonResponse({ error: `Could not fetch payment methods: ${vaultedError.message}` }, 500, corsHeaders);
    }

    if (vaultedMethods.length === 0) {
      return jsonResponse({ error: "No vaulted payment methods found on this order" }, 400, corsHeaders);
    }

    // Use selected mandate from frontend, or fall back to first one
    const mandateId = selectedMandateId || vaultedMethods[0].id;
    console.log("Using mandate:", mandateId);

    const outstandingAmount = parseFloat(outstandingMoney?.amount || "0");
    if (parsedAmount > outstandingAmount) {
      return jsonResponse({
        error: `Amount ${parsedAmount} exceeds outstanding balance of ${outstandingAmount}`,
      }, 400, corsHeaders);
    }

    // Call orderCreateMandatePayment
    console.log("Payment details:", { orderId, mandateId, parsedAmount, currencyCode });
    const idempotencyKey = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    let paymentData;
    try {
      const paymentResponse = await admin.graphql(
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
            job {
              id
              done
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            id: orderId,
            mandateId,
            idempotencyKey,
            amount: {
              amount: parsedAmount.toFixed(2),
              currencyCode,
            },
          },
        },
      );
      paymentData = await paymentResponse.json();
    } catch (payError) {
      console.error("Payment mutation error:", payError.message);
      return jsonResponse({ error: `Payment mutation failed: ${payError.message}` }, 500, corsHeaders);
    }

    const mutation = paymentData.data?.orderCreateMandatePayment;

    if (mutation?.userErrors?.length > 0) {
      const errorMessages = mutation.userErrors.map((e) => e.message).join("; ");
      return jsonResponse({ error: `Payment failed: ${errorMessages}` }, 400, corsHeaders);
    }

    const job = mutation?.job;
    if (!job) {
      return jsonResponse({ error: "Payment mutation did not return a job" }, 500, corsHeaders);
    }

    // Poll the job until it resolves
    const jobResult = await pollJob(admin, job.id);

    if (jobResult.done) {
      const updatedOrderResponse = await admin.graphql(
        `#graphql
        query GetUpdatedOrder($orderId: ID!) {
          order(id: $orderId) {
            id
            name
            displayFinancialStatus
            totalOutstandingSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }`,
        { variables: { orderId } },
      );

      const updatedOrderData = await updatedOrderResponse.json();
      const updatedOrder = updatedOrderData.data?.order;

      return jsonResponse({
        success: true,
        message: `Payment of ${currencyCode} ${parsedAmount.toFixed(2)} applied to order ${updatedOrder?.name || orderId}.`,
        order: {
          id: updatedOrder?.id,
          name: updatedOrder?.name,
          financialStatus: updatedOrder?.displayFinancialStatus,
          remainingBalance: updatedOrder?.totalOutstandingSet?.shopMoney,
        },
      }, 200, corsHeaders);
    }

    return jsonResponse({
      success: true,
      message: `Payment submitted but still processing. Job ID: ${job.id}`,
      pending: true,
    }, 202, corsHeaders);
  } catch (error) {
    console.error("Pay invoice error:", error);
    if (error.graphQLErrors) {
      console.error("GraphQL errors:", JSON.stringify(error.graphQLErrors, null, 2));
    }
    if (error.response) {
      try {
        const body = await error.response.json?.();
        console.error("Error response body:", JSON.stringify(body, null, 2));
      } catch {}
    }
    return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
  }
}

// Handle CORS preflight
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

async function pollJob(admin, jobId, maxAttempts = 10, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const response = await admin.graphql(
      `#graphql
      query GetJob($jobId: ID!) {
        job(id: $jobId) {
          id
          done
        }
      }`,
      { variables: { jobId } },
    );

    const data = await response.json();
    const job = data.data?.job;

    if (!job) {
      return { done: false, error: "Job not found" };
    }

    if (job.done) {
      return { done: true };
    }
  }

  return { done: false };
}
