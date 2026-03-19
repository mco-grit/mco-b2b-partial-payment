import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback } from "preact/hooks";
import {
  useOrder,
  useSessionToken,
  useExtension,
} from "@shopify/ui-extensions/customer-account/preact";

export default async () => {
  render(<ActionExtension />, document.body);
};

function ActionExtension() {
  let order, sessionToken, ext;

  try {
    order = useOrder();
    sessionToken = useSessionToken();
    ext = useExtension();
  } catch (err) {
    return (
      <s-text>Error loading extension: {String(err)}</s-text>
    );
  }

  // Debug: log the order object to understand its structure
  console.log("order-pay-action: order object", JSON.stringify(order, null, 2));

  if (!order) {
    return <s-text>Loading order...</s-text>;
  }

  // Try different possible field names for outstanding amount
  const outstanding =
    order.totalOutstandingAmount ||
    order.outstandingAmount ||
    order.totalOutstanding;

  const currencyCode = outstanding?.currencyCode || order?.currencyCode || "GBP";
  const outstandingValue = outstanding?.amount
    ? parseFloat(outstanding.amount)
    : 0;

  const [amount, setAmount] = useState(
    outstandingValue > 0 ? outstandingValue.toFixed(2) : "",
  );
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  const handleSubmit = useCallback(async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setStatus("error");
      setMessage("Please enter a valid amount greater than 0.");
      return;
    }

    if (outstandingValue > 0 && parsedAmount > outstandingValue) {
      setStatus("error");
      setMessage(
        `Amount cannot exceed the outstanding balance of ${currencyCode} ${outstandingValue.toFixed(2)}.`,
      );
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const token = await sessionToken.get();
      const appUrl = ext.appUrl;

      const response = await fetch(`${appUrl}/api/pay-invoice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId: order.id,
          amount: parsedAmount.toFixed(2),
          currencyCode,
        }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setStatus("success");
        setMessage(
          result.message ||
            `Payment of ${currencyCode} ${parsedAmount.toFixed(2)} submitted successfully.`,
        );
      } else {
        setStatus("error");
        setMessage(result.error || "Payment failed. Please try again.");
      }
    } catch (err) {
      setStatus("error");
      setMessage("An unexpected error occurred. Please try again.");
    }
  }, [amount, outstandingValue, currencyCode, order, sessionToken, ext]);

  if (status === "success") {
    return (
      <s-block-stack spacing="base">
        <s-banner status="success">
          <s-text>{message}</s-text>
        </s-banner>
        <s-button onPress={() => shopify.customerAccount.close()}>
          Done
        </s-button>
      </s-block-stack>
    );
  }

  return (
    <s-block-stack spacing="base">
      <s-heading>Pay Invoice</s-heading>
      {outstandingValue > 0 ? (
        <s-text>
          Outstanding balance: {currencyCode} {outstandingValue.toFixed(2)}
        </s-text>
      ) : (
        <s-text>Enter the amount to pay for order {order.name || order.id}</s-text>
      )}

      <s-text-field
        label="Payment amount"
        type="number"
        value={amount}
        onInput={(e) => setAmount(e.target.value)}
        disabled={status === "loading"}
      />

      {status === "error" && (
        <s-banner status="critical">
          <s-text>{message}</s-text>
        </s-banner>
      )}

      <s-inline-stack spacing="base">
        <s-button
          kind="primary"
          onPress={handleSubmit}
          loading={status === "loading"}
          disabled={status === "loading"}
        >
          Pay {currencyCode} {amount || "0.00"}
        </s-button>
        <s-button
          onPress={() => shopify.customerAccount.close()}
          disabled={status === "loading"}
        >
          Cancel
        </s-button>
      </s-inline-stack>
    </s-block-stack>
  );
}
