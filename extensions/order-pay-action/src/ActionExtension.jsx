import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import {
  useOrder,
  useSessionToken,
  useExtension,
} from "@shopify/ui-extensions/customer-account/preact";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<ActionExtension />, document.body);
};

function ActionExtension() {
  const order = useOrder();
  const sessionToken = useSessionToken();
  const ext = useExtension();

  const orderId = order?.id;
  const submitting = useRef(false);

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [orderInfo, setOrderInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedMandateId, setSelectedMandateId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function fetchOrderInfo() {
      try {
        const token = await sessionToken.get();

        const response = await fetch(`${APP_URL}/api/pay-invoice`, {
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
          // Select first non-expired card by default
          const methods = result.order.paymentMethods || [];
          const validMethod = methods.find((m) => !m.expired);
          if (validMethod) {
            setSelectedMandateId(validMethod.id);
          }
        }
      } catch (err) {
        console.error("Failed to fetch order info:", err);
      } finally {
        setLoading(false);
      }
    }

    if (orderId) {
      fetchOrderInfo();
    }
  }, [orderId]);

  const handleSubmit = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setStatus("error");
      setMessage("Please enter a valid amount greater than 0.");
      submitting.current = false;
      return;
    }

    const outstanding = parseFloat(orderInfo?.outstandingAmount || "0");
    if (parsedAmount > outstanding) {
      setStatus("error");
      setMessage(
        `Amount cannot exceed outstanding balance of ${orderInfo?.currencyCode} ${outstanding.toFixed(2)}.`,
      );
      submitting.current = false;
      return;
    }

    if (!selectedMandateId) {
      setStatus("error");
      setMessage("Please select a payment method.");
      submitting.current = false;
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const token = await sessionToken.get();

      const response = await fetch(`${APP_URL}/api/pay-invoice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId,
          amount: parsedAmount.toFixed(2),
          currencyCode: orderInfo?.currencyCode || "GBP",
          mandateId: selectedMandateId,
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
        if (result.order?.remainingBalance) {
          setOrderInfo((prev) => ({
            ...prev,
            outstandingAmount: result.order.remainingBalance.amount,
          }));
        }
      } else {
        setStatus("error");
        setMessage(result.error || "Payment failed. Please try again.");
        submitting.current = false;
      }
    } catch (err) {
      setStatus("error");
      setMessage("An unexpected error occurred. Please try again.");
      submitting.current = false;
    }
  }, [amount, orderId, orderInfo, selectedMandateId, sessionToken]);

  if (loading) {
    return null;
  }

  if (orderInfo && parseFloat(orderInfo.outstandingAmount) <= 0) {
    return null;
  }

  if (status === "success") {
    return (
      <s-section>
        <s-banner status="success">
          <s-text>{message}</s-text>
        </s-banner>
        {orderInfo && parseFloat(orderInfo.outstandingAmount) > 0 && (
          <s-text>
            Remaining balance: {orderInfo.currencyCode}{" "}
            {orderInfo.outstandingAmount}
          </s-text>
        )}
      </s-section>
    );
  }

  if (dismissed) {
    return null;
  }

  if (!expanded) {
    return (
      <s-section>
        <s-stack direction="inline" justify-content="end">
          <s-button
            variant="primary"
            onClick={() => setExpanded(true)}
          >
            {shopify.i18n.translate("makeAPayment")}
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  const paymentMethods = orderInfo?.paymentMethods || [];

  return (
    <s-section>
      <s-heading>Pay Invoice</s-heading>

      {orderInfo ? (
        <s-text>
          Outstanding balance: {orderInfo.currencyCode}{" "}
          {orderInfo.outstandingAmount}
        </s-text>
      ) : (
        <s-text>Could not load order details.</s-text>
      )}

      {paymentMethods.length > 1 && (
        <s-select
          label="Payment method"
          value={selectedMandateId}
          onChange={(e) => setSelectedMandateId(e.target.value)}
          disabled={status === "loading"}
        >
          {paymentMethods
            .filter((m) => !m.expired)
            .map((m) => (
              <s-option key={m.id} value={m.id}>
                {m.brand} •••• {m.lastDigits} ({m.name}, exp {m.expiryMonth}/{m.expiryYear})
              </s-option>
            ))}
        </s-select>
      )}

      {paymentMethods.length === 1 && (
        <s-text>
          Card: {paymentMethods[0].brand} •••• {paymentMethods[0].lastDigits} ({paymentMethods[0].name})
        </s-text>
      )}

      {paymentMethods.length === 0 && (
        <s-banner status="critical">
          <s-text>No payment methods found. Please add a card to your account.</s-text>
        </s-banner>
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

      <s-stack direction="inline" gap="base" justify-content="end">
        <s-button
          onClick={() => setDismissed(true)}
          disabled={status === "loading"}
        >
          {shopify.i18n.translate("notNow")}
        </s-button>
        <s-button
          variant="primary"
          onClick={handleSubmit}
          loading={status === "loading"}
          disabled={status === "loading" || !amount || !selectedMandateId}
        >
          Pay {orderInfo?.currencyCode || ""} {amount || "0.00"}
        </s-button>
      </s-stack>
    </s-section>
  );
}
