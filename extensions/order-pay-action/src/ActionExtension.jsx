import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default async () => {
  render(<ActionExtension />, document.body);
};

function ActionExtension() {
  return (
    <s-card>
      <s-text>Pay Invoice extension loaded successfully.</s-text>
    </s-card>
  );
}
