/**
 * Generates docs/ENVIRONMENT.md from src/config/envSchema.ts.
 *
 *   npm run docs:env          # write the reference
 *   npm run docs:env:check    # exit 1 if the committed reference is stale (CI)
 *
 * Issue: #2211
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join, relative } from "path";
import { renderEnvReference } from "../src/config/envDocs";

const OUTPUT = join(__dirname, "..", "docs", "ENVIRONMENT.md");
const check = process.argv.includes("--check");

const rendered = renderEnvReference();
const displayPath = relative(process.cwd(), OUTPUT);

if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
  if (current !== rendered) {
    console.error(
      `${displayPath} is out of date with src/config/envSchema.ts.\n` +
        "Run 'npm run docs:env' from backend/ and commit the result."
    );
    process.exit(1);
  }
  console.log(`${displayPath} is up to date.`);
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${displayPath}`);
}
