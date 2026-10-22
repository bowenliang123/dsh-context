// React 18 `act` flushes effects synchronously only with this flag; the jsdom component specs opt in per file.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
