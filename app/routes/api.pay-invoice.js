import { authenticate } from "../shopify.server";
import "@shopify/shopify-api/adapters/node";
import { createAdminApiClient } from "@shopify/admin-api-client";

function getAdminClient() {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
  }
  return createAdminApiClient({
    storeDomain: store,
    apiVersion: "2025-01",
    accessToken: token,
  });
}

async function adminGraphql(query, variables = {}) {
  const client = getAdminClient();
  const response = await client.request(query, { variables });
  return response;
}

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
    const body = await request.json();
    const { orderId, action: requestAction } = body;

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId" }, 400, corsHeaders);
    }

    // Fetch order details
    const orderData = await adminGraphql(
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
          paymentCollectionDetails {
            vaultedPaymentMethods {
              id
              name
              paymentMethodId
            }
          }
        }
      }`,
      { orderId },
    );

    if (orderData.data?.order == null) {
      return jsonResponse({ error: "Order not found" }, 404, corsHeaders);
    }

    const order = orderData.data.order;
    const outstandingMoney = order.totalOutstandingSet?.shopMoney;

    // --- GET INFO ---
    if (requestAction === "get-info") {
      return jsonResponse({
        order: {
          id: order.id,
          name: order.name,
          financialStatus: order.displayFinancialStatus,
          outstandingAmount: outstandingMoney?.amount || "0",
          currencyCode: outstandingMoney?.currencyCode || "GBP",
        },
      }, 200, corsHeaders);
    }

    // --- PAY ---
    const { amount, currencyCode } = body;

    if (!amount || !currencyCode) {
      return jsonResponse({ error: "Missing required fields: amount, currencyCode" }, 400, corsHeaders);
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return jsonResponse({ error: "Amount must be a positive number" }, 400, corsHeaders);
    }

    const vaultedMethods = order.paymentCollectionDetails?.vaultedPaymentMethods || [];

    if (vaultedMethods.length === 0) {
      return jsonResponse({ error: "No vaulted payment methods found on this order" }, 400, corsHeaders);
    }

    const mandateId = vaultedMethods[0].id;

    const outstandingAmount = parseFloat(outstandingMoney?.amount || "0");
    if (parsedAmount > outstandingAmount) {
      return jsonResponse({
        error: `Amount ${parsedAmount} exceeds outstanding balance of ${outstandingAmount}`,
      }, 400, corsHeaders);
    }

    // Call orderCreateMandatePayment
    const idempotencyKey = crypto.randomUUID();
    const paymentData = await adminGraphql(
      `#graphql
      mutation OrderCreateMandatePayment(
        $orderId: ID!
        $mandateId: ID!
        $amount: MoneyInput!
        $idempotencyKey: String!
      ) {
        orderCreateMandatePayment(
          orderId: $orderId
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
        orderId,
        mandateId,
        idempotencyKey,
        amount: {
          amount: parsedAmount.toFixed(2),
          currencyCode,
        },
      },
    );

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
    const jobResult = await pollJob(job.id);

    if (jobResult.done) {
      const updatedOrderData = await adminGraphql(
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
        { orderId },
      );

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

async function pollJob(jobId, maxAttempts = 10, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const data = await adminGraphql(
      `#graphql
      query GetJob($jobId: ID!) {
        job(id: $jobId) {
          id
          done
          errors {
            code
            field
            message
          }
        }
      }`,
      { jobId },
    );

    const job = data.data?.job;

    if (!job) {
      return { done: false, error: "Job not found" };
    }

    if (job.done) {
      if (job.errors?.length > 0) {
        throw new Error(
          `Job completed with errors: ${job.errors.map((e) => e.message).join("; ")}`,
        );
      }
      return { done: true };
    }
  }

  return { done: false };
}
