// Client project setup: React 18 `act` requires this flag to flush effects
// synchronously in tests; every jsdom spec shares the real React runtime.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { resetModelPrices, setModelPricesLoader } from '../../src/client/modelPrices'

// jsdom does not implement scrollIntoView; the plugin calls it when focusing
// a browser row. A no-op polyfill stands in for the platform (layout-free).
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

// The model-price store starts DORMANT in tests: its loader resolves never,
// so no spec ever reaches the network. Specs that need prices inject their
// own loader (resetModelPrices + setModelPricesLoader, see modelPrices.spec).
resetModelPrices()
setModelPricesLoader(() => new Promise(() => {}))
