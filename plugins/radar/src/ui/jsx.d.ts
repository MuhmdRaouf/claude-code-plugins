/**
 * The shared UI package's markdown renders JSX but lives outside this plugin's node_modules, where
 * "preact/jsx-runtime" does not resolve for its files. Bridging preact's JSX namespace onto the global one
 * gives every .tsx in the program the same intrinsics, radar's own included.
 */

import type { JSX as PreactJSX } from "preact";

declare global {
  namespace JSX {
    export type Element = PreactJSX.Element;
    export type ElementClass = PreactJSX.ElementClass;
    export type ElementAttributesProperty = PreactJSX.ElementAttributesProperty;
    export type ElementChildrenAttribute = PreactJSX.ElementChildrenAttribute;
    export interface IntrinsicElements extends PreactJSX.IntrinsicElements {}
    export interface IntrinsicAttributes extends PreactJSX.IntrinsicAttributes {}
  }
}
