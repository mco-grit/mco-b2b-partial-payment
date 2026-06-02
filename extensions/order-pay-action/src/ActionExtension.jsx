import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import {
  useOrder,
  useSessionToken,
  useExtension,
} from "@shopify/ui-extensions/customer-account/preact";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<ActionExtension />, document.body);
};

function t(key, vars) {
  try {
    return shopify.i18n.translate(key, vars);
  } catch (e) {
    return key;
  }
}

function friendlyError(raw) {
  if (!raw) return t("errorGeneric");
  const lower = raw.toLowerCase();
  if (lower.includes("currency") && lower.includes("match")) return t("errorCurrencyMismatch");
  if (lower.includes("declined") || lower.includes("balance did not decrease")) return t("errorCardDeclined");
  if (lower.includes("no matching payment method")) return t("errorNoMatchingCard");
  return raw;
}

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

  const formatMoney = useMemo(() => {
    const currency = orderInfo?.currencyCode;
    if (!currency) return (v) => String(v);
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    return (v) => {
      const n = parseFloat(v);
      return isNaN(n) ? String(v) : formatter.format(n);
    };
  }, [orderInfo?.currencyCode]);

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
      setMessage(t("enterValidAmountGreaterThanZero"));
      submitting.current = false;
      return;
    }

    const outstanding = parseFloat(orderInfo?.outstandingAmount || "0");
    if (parsedAmount > outstanding) {
      setStatus("error");
      setMessage(t("amountExceedsBalance", { amount: formatMoney(outstanding.toFixed(2)) }));
      submitting.current = false;
      return;
    }

    if (!selectedMandateId) {
      setStatus("error");
      setMessage(t("selectPaymentMethod"));
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
        const orderName = result.order?.name || orderId;
        setMessage(
          result.pending
            ? t("paymentStillProcessing")
            : t("paymentApplied", { amount: formatMoney(parsedAmount), orderName }),
        );
        if (result.order?.remainingBalance) {
          setOrderInfo((prev) => ({
            ...prev,
            outstandingAmount: result.order.remainingBalance.amount,
          }));
        }
      } else {
        setStatus("error");
        setMessage(friendlyError(result.error) || t("paymentFailed"));
        submitting.current = false;
      }
    } catch (err) {
      setStatus("error");
      setMessage(t("unexpectedError"));
      submitting.current = false;
    }
  }, [amount, orderId, orderInfo, selectedMandateId, sessionToken]);

  const handleDone = useCallback(() => {
    setStatus("idle");
    setMessage("");
    setExpanded(false);
    submitting.current = false;
  }, []);

  if (loading) {
    return null;
  }

  if (orderInfo && parseFloat(orderInfo.outstandingAmount) <= 0) {
    return null;
  }

  if (status === "success") {
    return (
      <s-stack direction="block" gap="base">
        <s-banner status="success">
          <s-text>{message}</s-text>
        </s-banner>
        {orderInfo && parseFloat(orderInfo.outstandingAmount) > 0 && (
          <s-text>
            {t("remainingBalance", { amount: formatMoney(orderInfo.outstandingAmount) })}
          </s-text>
        )}
        <s-grid gridTemplateColumns="1fr auto" gap="base">
          <s-grid-item />
          <s-grid-item>
            <s-button variant="primary" onClick={handleDone}>
              {t("done")}
            </s-button>
          </s-grid-item>
        </s-grid>
      </s-stack>
    );
  }

  if (!expanded) {
    return (
      <s-grid gridTemplateColumns="1fr auto">
        <s-grid-item />
        <s-grid-item>
          <s-button
            variant="primary"
            onClick={() => setExpanded(true)}
          >
            {t("makeAPayment")}
          </s-button>
        </s-grid-item>
      </s-grid>
    );
  }

  const paymentMethods = orderInfo?.paymentMethods || [];

  return (
    <s-stack direction="block" gap="base">
      <s-heading>{t("payInvoice")}</s-heading>

      {orderInfo ? (
        <s-text>
          {t("outstandingBalance")}: {formatMoney(orderInfo.outstandingAmount)}
        </s-text>
      ) : (
        <s-text>{t("couldNotLoadOrder")}</s-text>
      )}

      {paymentMethods.length > 1 && (
        <s-select
          label={t("paymentMethod")}
          value={selectedMandateId}
          onChange={(e) => setSelectedMandateId(e.target.value)}
          disabled={status === "loading"}
        >
          {paymentMethods
            .filter((m) => !m.expired)
            .map((m) => (
              <s-option key={m.id} value={m.id}>
                {t("cardSelectOption", {
                  brand: m.brand,
                  digits: m.lastDigits,
                  name: m.name,
                  expiryMonth: m.expiryMonth,
                  expiryYear: m.expiryYear,
                })}
              </s-option>
            ))}
        </s-select>
      )}

      {paymentMethods.length === 1 && (
        <s-text>
          {t("cardDisplay", {
            brand: paymentMethods[0].brand,
            digits: paymentMethods[0].lastDigits,
            name: paymentMethods[0].name,
          })}
        </s-text>
      )}

      {paymentMethods.length === 0 && (
        <s-banner status="critical">
          <s-text>{t("noPaymentMethodsAction")}</s-text>
        </s-banner>
      )}

      <s-text-field
        label={t("paymentAmount")}
        value={amount}
        onInput={(e) => setAmount(e.target.value)}
        disabled={status === "loading"}
      />

      {status === "error" && (
        <s-banner status="critical">
          <s-text>{message}</s-text>
        </s-banner>
      )}

      {status === "loading" && (
        <s-banner status="warning">
          <s-text>{t("processingPayment")}</s-text>
        </s-banner>
      )}

      <s-grid gridTemplateColumns="1fr auto auto" gap="base">
        <s-grid-item />
        <s-grid-item>
          <s-button
            onClick={() => setExpanded(false)}
            disabled={status === "loading"}
          >
            {t("notNow")}
          </s-button>
        </s-grid-item>
        <s-grid-item>
          <s-button
            variant="primary"
            onClick={handleSubmit}
            loading={status === "loading"}
            disabled={status === "loading" || !amount || !selectedMandateId}
          >
            {t("payAmount", { amount: formatMoney(amount || "0.00") })}
          </s-button>
        </s-grid-item>
      </s-grid>
    </s-stack>
  );
}
