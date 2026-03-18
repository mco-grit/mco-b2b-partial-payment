import { authenticate, unauthenticated } from "../shopify.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let cors = (response) => response;

  try {
    // Validate the customer session token and get CORS helper
    const auth = await authenticate.public.customerAccount(request);
    cors = auth.cors;

    // Extract the shop domain from the session token (dest claim is the shop URL)
    const shopDomain = new URL(auth.sessionToken.dest).hostname;

    // Get Admin API client using the app's offline access token
    const { admin } = await unauthenticated.admin(shopDomain);

    const body = await request.clone().json();
    const { orderId, amount, currencyCode } = body;

    if (!orderId || !amount || !currencyCode) {
      return cors(jsonResponse({ error: "Missing required fields: orderId, amount, currencyCode" }, 400));
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return cors(jsonResponse({ error: "Amount must be a positive number" }, 400));
    }

    // Step 1: Look up the order and its vaulted payment methods
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
          paymentCollectionDetails {
            vaultedPaymentMethods {
              id
              name
              paymentMethodId
            }
          }
        }
      }`,
      { variables: { orderId } },
    );

    const orderData = await orderResponse.json();

    if (orderData.data?.order == null) {
      return cors(jsonResponse({ error: "Order not found" }, 404));
    }

    const order = orderData.data.order;
    const vaultedMethods = order.paymentCollectionDetails?.vaultedPaymentMethods || [];

    if (vaultedMethods.length === 0) {
      return cors(jsonResponse({ error: "No vaulted payment methods found on this order" }, 400));
    }

    // Use the first vaulted payment method
    const mandateId = vaultedMethods[0].id;

    // Validate amount doesn't exceed outstanding balance
    const outstandingAmount = parseFloat(
      order.totalOutstandingSet?.shopMoney?.amount || "0",
    );
    if (parsedAmount > outstandingAmount) {
      return cors(jsonResponse({
        error: `Amount ${parsedAmount} exceeds outstanding balance of ${outstandingAmount}`,
      }, 400));
    }

    // Step 2: Call orderCreateMandatePayment
    const idempotencyKey = crypto.randomUUID();
    const paymentResponse = await admin.graphql(
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
        variables: {
          orderId,
          mandateId,
          idempotencyKey,
          amount: {
            amount: parsedAmount.toFixed(2),
            currencyCode,
          },
        },
      },
    );

    const paymentData = await paymentResponse.json();
    const mutation = paymentData.data?.orderCreateMandatePayment;

    if (mutation?.userErrors?.length > 0) {
      const errorMessages = mutation.userErrors.map((e) => e.message).join("; ");
      return cors(jsonResponse({ error: `Payment failed: ${errorMessages}` }, 400));
    }

    const job = mutation?.job;
    if (!job) {
      return cors(jsonResponse({ error: "Payment mutation did not return a job" }, 500));
    }

    // Step 3: Poll the job until it resolves (max ~20s)
    const jobResult = await pollJob(admin, job.id);

    if (jobResult.done) {
      // Fetch updated order status to confirm
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

      return cors(jsonResponse({
        success: true,
        message: `Payment of ${currencyCode} ${parsedAmount.toFixed(2)} applied to order ${updatedOrder?.name || orderId}.`,
        order: {
          id: updatedOrder?.id,
          name: updatedOrder?.name,
          financialStatus: updatedOrder?.displayFinancialStatus,
          remainingBalance: updatedOrder?.totalOutstandingSet?.shopMoney,
        },
      }));
    }

    // Job didn't finish in time — return pending status
    return cors(jsonResponse({
      success: true,
      message: `Payment submitted but still processing. Job ID: ${job.id}`,
      pending: true,
    }, 202));
  } catch (error) {
    console.error("Pay invoice error:", error);
    return cors(jsonResponse({ error: "Internal server error" }, 500));
  }
}

// Handle CORS preflight
export async function loader({ request }) {
  const { cors } = await authenticate.public.customerAccount(request);
  return cors(new Response(null, { status: 204 }));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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
          errors {
            code
            field
            message
          }
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
