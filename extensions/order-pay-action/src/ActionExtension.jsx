import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import {
  useSessionToken,
  useExtension,
  useApi,
} from "@shopify/ui-extensions/customer-account/preact";

export default async () => {
  render(<ActionExtension />, document.body);
};

function ActionExtension() {
  const sessionToken = useSessionToken();
  const ext = useExtension();
  const api = useApi();

  // The action extension only gives us orderId, not the full order
  const orderId = api.orderId;

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [orderInfo, setOrderInfo] = useState(null);

  // Fetch order details from our backend on mount
  useEffect(() => {
    async function fetchOrderInfo() {
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
            orderId,
            action: "get-info",
          }),
        });

        const result = await response.json();
        if (result.order) {
          setOrderInfo(result.order);
          const outstanding = result.order.outstandingAmount;
          if (outstanding) {
            setAmount(outstanding);
          }
        }
      } catch (err) {
        console.error("Failed to fetch order info:", err);
      }
    }

    if (orderId) {
      fetchOrderInfo();
    }
  }, [orderId]);

  const handleSubmit = useCallback(async () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setStatus("error");
      setMessage("Please enter a valid amount greater than 0.");
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
          orderId,
          amount: parsedAmount.toFixed(2),
          currencyCode: orderInfo?.currencyCode || "GBP",
          action: "pay",
        }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setStatus("success");
        setMessage(
          result.message ||
            `Payment of ${parsedAmount.toFixed(2)} submitted successfully.`,
        );
      } else {
        setStatus("error");
        setMessage(result.error || "Payment failed. Please try again.");
      }
    } catch (err) {
      setStatus("error");
      setMessage("An unexpected error occurred. Please try again.");
    }
  }, [amount, orderId, orderInfo, sessionToken, ext]);

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

      {orderInfo ? (
        <s-text>
          Outstanding balance: {orderInfo.currencyCode} {orderInfo.outstandingAmount}
        </s-text>
      ) : (
        <s-text>Loading order details...</s-text>
      )}

      <s-text-field
        label="Payment amount"
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
          disabled={status === "loading" || !amount}
        >
          Pay {amount || "0.00"}
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
