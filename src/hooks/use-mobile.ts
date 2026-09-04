import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)` //window.matchMedia = does the current window match this css media query?

// A media query is an external store, so it's read via useSyncExternalStore
// rather than a useState + useEffect pair. The previous version called
// setIsMobile() synchronously in the effect body, which renders once with
// `undefined`, then immediately re-renders with the real value - a cascading
// render that react-hooks/set-state-in-effect flags. useSyncExternalStore
// gets the correct value on the first client render instead, and the
// server snapshot below keeps SSR deterministic.
function subscribe(onStoreChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onStoreChange)
  return () => mql.removeEventListener("change", onStoreChange)
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

// There's no viewport on the server - false matches the old hook's
// `!!isMobile` behavior, which also resolved its initial `undefined` to false.
function getServerSnapshot(): boolean {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
