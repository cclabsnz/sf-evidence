# Test stubs

## `chalk.mjs`

`jest.config.ts` maps `^chalk$` here.

Anything importing `@salesforce/sf-plugins-core` — every file under `src/commands/` — used to
throw `ReferenceError: Cannot access 'supportsColor' before initialization` from
`chalk/source/index.js:8` the moment Jest loaded it. chalk 5 resolves its colour support
through the `#supports-color` subpath import declared in its own `package.json`; under
jest-resolve's ESM linker that request resolves back into a module graph that has not
finished evaluating, so the imported binding is still in its temporal dead zone when
`index.js` destructures it. Nothing in this repo is involved: importing `collect.ts` alone,
with an empty test body, reproduces it.

Mapping `#supports-color` to a stub does not help — the resolution failure is upstream of it.
Replacing `chalk` itself does, which is what this file is. It is a chainable no-op proxy: any
property access returns the proxy, and calling it returns its first argument unchanged.

Consequence: command output under test is never colourised. That is fine — no test asserts on
colour, and uncoloured output is easier to assert on. If a test ever needs real chalk
behaviour, it needs a different approach, not a richer stub.
