// Copies the built web app (packages/web/dist) into the CLI's dist/web, which `docsworth
// serve` serves at /. By path, never by import: core doesn't import packages/
// (test/layering.test.ts). `npm run build` removes dist/ first, so this only adds files.
import { cpSync, existsSync } from "node:fs";

const FROM = "packages/web/dist";
if (!existsSync(`${FROM}/index.html`)) {
  console.error(`copy-web: ${FROM}/index.html is missing; \`npm run build -w @docsworth/web\` builds it`);
  process.exit(1);
}
cpSync(FROM, "dist/web", { recursive: true });
