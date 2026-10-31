/**
 * Minimal DOM implementation for testing canonical text (the server parses
 * epub XHTML with @xmldom/xmldom, whose nodes already satisfy CTNode).
 */
import type { CTElement, CTNode, CTText } from "./canonical-text.js";

function el(nodeName: string, children: CTNode[] = [], attrs: Record<string, string> = {}): CTElement {
  return {
    nodeType: 1,
    nodeName: nodeName.toUpperCase(),
    childNodes: children,
    hasAttribute: (n) => n in attrs,
    getAttribute: (n) => (n in attrs ? (attrs[n] ?? null) : null),
  };
}
function txt(data: string): CTText {
  return { nodeType: 3, nodeName: "#text", data };
}

export { el, txt };
export type { CTElement, CTNode, CTText };
