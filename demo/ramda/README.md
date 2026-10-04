# Ramda (Contrail demo copy)

This is the source and test suite of [Ramda](https://github.com/ramda/ramda) 0.32.0 (MIT, see
[LICENSE.txt](LICENSE.txt)), imported as a real-world codebase for Contrail's agent swarm demo.

- `source/` — one function per file, re-exported from `source/index.js`.
- `test/` — Ramda's mocha test files. The JSDoc examples runner and thirteen test files that need test-only npm packages
  (sanctuary, sinon) or Node-only modules (fs, vm, child_process) were left out.
- `vendor/fast-check.cjs` — the property-testing library some tests use, bundled into one file.

Run the tests without installing anything (Node 22.12 or later):

```bash
npm test                                   # every test file
node --no-warnings scripts/test.mjs test/add.js test/range.js
```

Contrail runs the same suite in a Dynamic Worker on every landing (see `contrail.json`).
