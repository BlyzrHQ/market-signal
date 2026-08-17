import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("bundles the approved Archivo and Abril font pairing", () => {
  assert.match(layout, /@fontsource-variable\/archivo/);
  assert.match(layout, /@fontsource\/abril-fatface\/400\.css/);
  assert.match(css, /--font-archivo: "Archivo Variable"/);
  assert.match(css, /--font-abril: "Abril Fatface"/);
});

test("uses Archivo for interface copy and Abril for display headings", () => {
  assert.match(css, /body \{[^}]*font-family: var\(--font-archivo\)/);
  assert.match(css, /\.hero-v2 h1 \{[^}]*font-family:var\(--font-abril\)/);
  assert.match(css, /\.panel-intro h2 \{[^}]*font-family: var\(--font-abril\)/);
  assert.match(css, /\.stored-report-page\[dir="rtl"\] \{ font-family: Tahoma/);
  assert.match(
    css,
    /\.stored-report-page\[dir="rtl"\] \.panel-intro h2,\.stored-report-page\[dir="rtl"\] \.stopped-report-card h1 \{ font-family: Tahoma/,
  );
});
