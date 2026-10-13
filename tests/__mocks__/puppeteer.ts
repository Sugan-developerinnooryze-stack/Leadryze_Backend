// Jest can't transform the real `puppeteer` package (it ships an ESM
// `export * from 'puppeteer-core'` re-export at its CJS entrypoint, which
// crashes ts-jest's CommonJS transform on load). No backend unit test
// actually launches a browser — real PDF rendering is covered by live
// Playwright verification, not these suites — so this stub stands in
// wherever something merely imports `puppeteer` at module-load time (e.g.
// pdf.service.ts, pulled in transitively by automation-flow.service.ts).
export default {
  launch: async () => {
    throw new Error('puppeteer is mocked in tests — no backend unit test should actually launch a browser');
  },
};
