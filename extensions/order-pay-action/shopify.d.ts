import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/MenuItemExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order.action.menu-item.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ActionExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
