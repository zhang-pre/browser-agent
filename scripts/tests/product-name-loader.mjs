// The dev fixtures are intentionally frozen during the product rename.
// Translate only their historical product identifier, preserving all assertions.
import { LEGACY_PRODUCT } from "../../additions/browser/components/agent-sidebar/modules/state/BrandCompatibility.sys.mjs";
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes("/agent-sidebar/dev/") && result.source != null) {
    const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    return { ...result, source: source.replaceAll(LEGACY_PRODUCT, "browser-agent") };
  }
  return result;
}
