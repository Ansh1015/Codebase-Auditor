## What & why

<!-- What does this change, and why? Link any related issue. -->

## How I verified it

<!-- Commands run, repos audited, before/after. -->

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (and new behaviour has tests in this PR)

## Trust-critical paths

<!-- Did you touch grounding (src/findings/ground.ts), patch verification
     (src/patch/verify.ts), or the import resolver (src/mapping/resolve.ts)?
     If so, call it out and describe how you kept the invariants intact. -->

- [ ] This PR does **not** weaken the grounding gate or auto-apply rejected patches.
