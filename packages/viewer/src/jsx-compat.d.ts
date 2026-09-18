// `@types/react` 19 removed the global `JSX` namespace in favour of `React.JSX` (the React 18 global
// was always the deprecated one). This project annotates component return types as `JSX.Element`
// throughout, so this shim re-exposes the global as an alias of the React namespace rather than
// rewriting ~90 call sites. Drop it if the annotations ever migrate to `React.JSX` / `ReactNode`.
import type * as React from "react";

declare global {
  namespace JSX {
    type ElementType = React.JSX.ElementType;
    type Element = React.JSX.Element;
    type ElementClass = React.JSX.ElementClass;
    type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
    type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;
    type IntrinsicElements = React.JSX.IntrinsicElements;
  }
}
