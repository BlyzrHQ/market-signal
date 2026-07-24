export function hasObservedAddToCartControl(document: string) {
  return /(?:add[\s_-]*to[\s_-]*(?:cart|bag|basket)|\bname\s*=\s*["'](?:add|add[\s_-]*to[\s_-]*(?:cart|bag|basket))["']|\/cart\/add(?:[/?#"'\\s]|$)|\bdata-product-form(?:\s|=|>))/i.test(document);
}
