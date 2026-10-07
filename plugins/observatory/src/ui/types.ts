/**
 * The UI is described as plain node trees built by pure functions; dom.ts turns them into real elements,
 * setting text via textContent only, so nothing user-derived is ever parsed as HTML. SVG geometry nodes
 * (path/line/rect/circle/text) are the same shape and get a namespace in dom.ts.
 */
export type UINode = {
  tag: string;
  cls?: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: UINode[];
  /** svg path data, kept out of attrs for readability */
  d?: string;
  /** stable identity for a node; the full re-render in dom.ts does not read it */
  key?: string;
};

export function el(tag: string, cls?: string, children?: UINode[], attrs?: Record<string, string>): UINode {
  const node: UINode = { tag };
  if (cls !== undefined) node.cls = cls;
  if (children !== undefined) node.children = children;
  if (attrs !== undefined) node.attrs = attrs;
  return node;
}

export function leaf(tag: string, cls: string, text: string, attrs?: Record<string, string>): UINode {
  return { tag, cls, text, ...(attrs !== undefined ? { attrs } : {}) };
}
