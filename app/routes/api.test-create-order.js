import { authenticate, unauthenticated } from "../shopify.server";

export async function loader({ request }) {
  const shop = "avon-prod.myshopify.com";
  const { admin } = await unauthenticated.admin(shop);

  try {
    // Step 1: Create the order
    const createResponse = await admin.graphql(
      `#graphql
      mutation {
        orderCreate(order: {
          lineItems: [
            {
              title: "Late Payment Fee"
              priceSet: {
                shopMoney: { amount: "5.00", currencyCode: GBP }
              }
              quantity: 1
            }
          ]
          customerId: "gid://shopify/Customer/24790261563718"
          financialStatus: PENDING
        }) {
          order {
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
          userErrors {
            field
            message
          }
        }
      }`,
    );

    const createData = await createResponse.json();
    const order = createData.data?.orderCreate?.order;
    const errors = createData.data?.orderCreate?.userErrors;

    if (errors?.length > 0 || !order) {
      return new Response(JSON.stringify({ errors, createData }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 2: Assign company location
    const assignResponse = await admin.graphql(
      `#graphql
      mutation AssignCompany($orderId: ID!) {
        orderUpdate(input: {
          id: $orderId
          purchasingEntity: {
            purchasingCompany: {
              companyId: "gid://shopify/Company/2993783110"
              companyLocationId: "gid://shopify/CompanyLocation/3232006470"
            }
          }
        }) {
          order {
            id
            name
            company {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { orderId: order.id } },
    );

    const assignData = await assignResponse.json();

    // Step 3: Query vaulted payment methods
    let vaultedData;
    try {
      const vaultedResponse = await admin.graphql(
        `#graphql
        query GetVaulted($orderId: ID!) {
          order(id: $orderId) {
            id
            name
            paymentCollectionDetails {
              vaultedPaymentMethods {
                id
              }
            }
          }
        }`,
        { variables: { orderId: order.id } },
      );
      vaultedData = await vaultedResponse.json();
    } catch (e) {
      vaultedData = { error: e.message };
    }

    // Step 4: Query CompanyLocation vaulted payment methods
    let locationVaultedData;
    try {
      const locationResponse = await admin.graphql(
        `#graphql
        query GetLocationVaulted {
          companyLocation(id: "gid://shopify/CompanyLocation/3232006470") {
            id
            name
            paymentMethods(first: 10) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }`,
      );
      locationVaultedData = await locationResponse.json();
    } catch (e) {
      locationVaultedData = { error: e.message };
    }

    return new Response(JSON.stringify({
      order,
      assignResult: assignData.data,
      orderVaultedPaymentMethods: vaultedData,
      locationVaultedPaymentMethods: locationVaultedData,
    }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
