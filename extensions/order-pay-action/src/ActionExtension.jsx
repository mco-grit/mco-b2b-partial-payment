import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import {
  useOrder,
  useSessionToken,
  useExtension,
} from "@shopify/ui-extensions/customer-account/preact";

export default async () => {
  render(<ActionExtension />, document.body);
};

function ActionExtension() {
  const order = useOrder();
  const sessionToken = useSessionToken();
  const ext = useExtension();

  const orderId = order?.id;

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [orderInfo, setOrderInfo] = useState(null);

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
          if (parseFloat(result.order.outstandingAmount) > 0) {
            setAmount(result.order.outstandingAmount);
          }
        }
      } catch (err) {
        console.error("Failed to fetch order info:", err);
        setMessage("Failed to load order details.");
        setStatus("error");
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

  if (!orderId) {
    return <s-text>Loading...</s-text>;
  }

  if (status === "success") {
    return (
      <s-card>
        <s-banner status="success">
          <s-text>{message}</s-text>
        </s-banner>
      </s-card>
    );
  }

  // Don't show the payment block if no outstanding balance
  if (orderInfo && parseFloat(orderInfo.outstandingAmount) <= 0) {
    return null;
  }

  return (
    <s-card>
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

      <s-button
        kind="primary"
        onPress={handleSubmit}
        loading={status === "loading"}
        disabled={status === "loading" || !amount}
      >
        Pay {orderInfo?.currencyCode || ""} {amount || "0.00"}
      </s-button>
    </s-card>
  );
}
