import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("landing header uses the shared brand mark without a beta badge", () => {
  const page = read("../app/page.tsx");
  const footer = read("../app/components/site-footer.tsx");
  const pricing = read("../app/pricing/page.tsx");
  const howItWorks = read("../app/how-it-works/page.tsx");
  assert.match(page, /<BrandMark \/>/);
  assert.match(footer, /<BrandMark \/>/);
  assert.match(pricing, /<BrandMark \/>/);
  assert.match(howItWorks, /<BrandMark \/>/);
  assert.doesNotMatch(page, /beta-pill|>BETA</);
  assert.doesNotMatch([page, footer, pricing, howItWorks].join("\n"), /className="brand-mark"><i/);
});

test("language switch exposes both states and an accessible target-language label", () => {
  const page = read("../app/page.tsx");
  assert.match(page, /className=\{!ar \? "active" : ""\}>EN/);
  assert.match(page, /className=\{ar \? "active" : ""\}>ع/);
  assert.match(page, /aria-label=\{ar \? "Switch language to English" : "تغيير اللغة إلى العربية"\}/);
});

test("brand mark remains code-native and the language switch has focus styling", () => {
  const mark = read("../app/components/brand-mark.tsx");
  const css = read("../app/globals.css");
  assert.match(mark, /<svg viewBox="0 0 28 28"/);
  assert.match(css, /\.language-switch:focus-visible/);
  assert.match(css, /\.language-switch span\.active/);
});
