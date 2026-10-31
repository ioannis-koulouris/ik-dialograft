# Dialograft – notes for coding agents

- TypeScript ESM, Node 22. `npm run typecheck`, `npm test`, `npm run build` must pass.
- Tools are defined once: Zod input in `src/tools/schemas.ts`, handler in `src/tools/registry.ts`. API, OpenAPI and MCP are generated from them; run `npm run contracts` after changing tools.
- Amounts are integer cents (`src/domain/money.ts`). Demo email recipients must end in `.invalid`.
- Protected (changes route to needs-human): auth/tokens, config, store, runner, worker, adapters, existing tests, package files, migrations, infra.
