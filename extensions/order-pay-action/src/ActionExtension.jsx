import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import {
  useOrder,
  useSessionToken,
} from "@shopify/ui-extensions/customer-account/preact";
import { useTranslations } from "./translations.js";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<ActionExtension />, document.body);
};

function friendlyError(raw, t) {
  if (!raw) return t("partial_pay_error_generic");
  const lower = raw.toLowerCase();
  if (lower.includes("currency") && lower.includes("match")) return t("partial_pay_error_currency_mismatch");
  if (lower.includes("declined") || lower.includes("balance did not decrease")) return t("partial_pay_error_card_declined");
  if (lower.includes("no matching payment method")) return t("partial_pay_error_no_matching_card");
  return raw;
}

function ActionExtension() {
  const order = useOrder();
  const sessionToken = useSessionToken();
  const t = useTranslations(APP_URL, () => sessionToken.get());

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
      setMessage(t("partial_pay_enter_valid_amount_gt_zero"));
      submitting.current = false;
      return;
    }

    const outstanding = parseFloat(orderInfo?.outstandingAmount || "0");
    if (parsedAmount > outstanding) {
      setStatus("error");
      setMessage(t("partial_pay_amount_exceeds_balance", { amount: formatMoney(outstanding.toFixed(2)) }));
      submitting.current = false;
      return;
    }

    if (!selectedMandateId) {
      setStatus("error");
      setMessage(t("partial_pay_select_payment_method"));
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
            ? t("partial_pay_payment_still_processing")
            : t("partial_pay_payment_applied", { amount: formatMoney(parsedAmount), orderName }),
        );
        if (result.order?.remainingBalance) {
          setOrderInfo((prev) => ({
            ...prev,
            outstandingAmount: result.order.remainingBalance.amount,
          }));
        }
      } else {
        setStatus("error");
        setMessage(friendlyError(result.error, t) || t("partial_pay_payment_failed"));
        submitting.current = false;
      }
    } catch (err) {
      setStatus("error");
      setMessage(t("partial_pay_unexpected_error"));
      submitting.current = false;
    }
  }, [amount, orderId, orderInfo, selectedMandateId, sessionToken, t]);

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
        <s-banner tone="success">
          <s-text>{message}</s-text>
        </s-banner>
        {orderInfo && parseFloat(orderInfo.outstandingAmount) > 0 && (
          <s-text>
            {t("partial_pay_remaining_balance", { amount: formatMoney(orderInfo.outstandingAmount) })}
          </s-text>
        )}
        <s-grid gridTemplateColumns="1fr auto" gap="base">
          <s-grid-item />
          <s-grid-item>
            <s-button variant="primary" onClick={handleDone}>
              {t("partial_pay_done")}
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
            {t("partial_pay_make_a_payment")}
          </s-button>
        </s-grid-item>
      </s-grid>
    );
  }

  const paymentMethods = orderInfo?.paymentMethods || [];

  return (
    <s-stack direction="block" gap="base">
      <s-heading>{t("partial_pay_pay_invoice")}</s-heading>

      {orderInfo ? (
        <s-text>
          {t("partial_pay_outstanding_balance")}: {formatMoney(orderInfo.outstandingAmount)}
        </s-text>
      ) : (
        <s-text>{t("partial_pay_could_not_load_order")}</s-text>
      )}

      {paymentMethods.length > 1 && (
        <s-select
          label={t("partial_pay_payment_method")}
          value={selectedMandateId}
          onChange={(e) => setSelectedMandateId(e.target.value)}
          disabled={status === "loading"}
        >
          {paymentMethods
            .filter((m) => !m.expired)
            .map((m) => (
              <s-option key={m.id} value={m.id}>
                {t("partial_pay_card_select_option", {
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
          {t("partial_pay_card_display", {
            brand: paymentMethods[0].brand,
            digits: paymentMethods[0].lastDigits,
            name: paymentMethods[0].name,
          })}
        </s-text>
      )}

      {paymentMethods.length === 0 && (
        <s-banner tone="critical">
          <s-text>{t("partial_pay_no_payment_methods_action")}</s-text>
        </s-banner>
      )}

      <s-text-field
        label={t("partial_pay_payment_amount")}
        value={amount}
        onInput={(e) => setAmount(e.target.value)}
        disabled={status === "loading"}
      />

      {status === "error" && (
        <s-banner tone="critical">
          <s-text>{message}</s-text>
        </s-banner>
      )}

      {status === "loading" && (
        <s-banner tone="warning">
          <s-text>{t("partial_pay_processing_payment")}</s-text>
        </s-banner>
      )}

      <s-grid gridTemplateColumns="1fr auto auto" gap="base">
        <s-grid-item />
        <s-grid-item>
          <s-button
            onClick={() => setExpanded(false)}
            disabled={status === "loading"}
          >
            {t("partial_pay_not_now")}
          </s-button>
        </s-grid-item>
        <s-grid-item>
          <s-button
            variant="primary"
            onClick={handleSubmit}
            loading={status === "loading"}
            disabled={status === "loading" || !amount || !selectedMandateId}
          >
            {t("partial_pay_pay_amount", { amount: formatMoney(amount || "0.00") })}
          </s-button>
        </s-grid-item>
      </s-grid>
    </s-stack>
  );
}
