"""Compare Scrapling with ordinary HTTP on a saved report's exact rival URLs.

Install the pinned benchmark dependency in an isolated environment with:
    python -m pip install "scrapling[fetchers]==0.4.11"

This is an evaluation harness, not a production crawler. It intentionally uses
the same conservative extractor for both transports so fetch and extraction
benefits stay distinguishable.
"""

from __future__ import annotations

import json
import html as html_entities
import os
import re
import statistics
import time
import urllib.request
import urllib.robotparser
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from lxml import html
from scrapling.fetchers import Fetcher


USER_AGENT = "MarketSignalBenchmark/1.0 (+public-data-evaluation)"
ROBOTS_AGENT = "MarketSignalBenchmark"

URLS = [
    "https://oasismarket.co.uk/product/beef-sirloin-steak-halal-500g",
    "https://www.thehalalfoodshop.com/products/volys-sliced-turkey-salami-style-150g",
    "https://www.thehalalfoodshop.com/products/puck-spread-500g",
    "https://mymeatshop.co.uk/product/white-onion/",
    "https://mymeatshop.co.uk/product/halal-beef-fillet-whole/",
    "https://mymeatshop.co.uk/product/halloumi-cheese-250g/",
    "https://oasismarket.co.uk/product/lamb-leg-halal-apx-2-3-2-5kg",
    "https://mymeatshop.co.uk/product/green-courgette/",
    "https://mymeatshop.co.uk/product/red-onion/",
    "https://www.thehalalfoodshop.com/products/humza-meat-samosas-20-pcs-650g-1",
    "https://mymeatshop.co.uk/product/mild-red-pepper-paste-700g/",
    "https://mymeatshop.co.uk/product/halal-beef-topside-whole/",
    "https://mymeatshop.co.uk/product/halal-lamb-riblet/",
    "https://mymeatshop.co.uk/product/halal-lamb-double-loin-chop/",
    "https://mymeatshop.co.uk/product/parsley-bunch/",
    "https://mymeatshop.co.uk/product/peeled-garlic/",
    "https://mymeatshop.co.uk/product/icing-sugar-pure-cane-white-500g/",
    "https://mymeatshop.co.uk/product/cherry-tomato-mix-red-yellow-500g-pack/",
    "https://mymeatshop.co.uk/product/halal-lamb-roasting-joint/",
    "https://mymeatshop.co.uk/product/halal-ribs/",
    "https://mymeatshop.co.uk/product/mint/",
    "https://mymeatshop.co.uk/product/sunflower-oil-1l/",
    "https://www.thehalalfoodshop.com/products/palestinian-delights-large-medjoul-dates-900g",
    "https://mymeatshop.co.uk/product/halal-beef-standing-rib-roast/",
    "https://mymeatshop.co.uk/product/halal-beef-shank-bone-in/",
    "https://www.thehalalfoodshop.com/products/jilanis-spicy-lamb-meat-balls-kofta-500g",
    "https://mymeatshop.co.uk/product/halal-milk-fed-veal-escalope-escalope-de-veau/",
    "https://mymeatshop.co.uk/product/lamb-liver/",
    "https://mymeatshop.co.uk/product/halal-milk-fed-veal-mince-hache-de-veau/",
]


@dataclass
class Observation:
    method: str
    url: str
    status: int
    bytes: int
    seconds: float
    title: str
    price: float | None
    currency: str
    image: str
    price_source: str
    error: str = ""


def records(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from records(child)
    elif isinstance(value, list):
        for child in value:
            yield from records(child)


def product_json_ld(document: str) -> list[dict[str, Any]]:
    tree = html.fromstring(document)
    products: list[dict[str, Any]] = []
    for raw in tree.xpath("//script[contains(translate(@type,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ld+json')]/text()"):
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        for item in records(payload):
            kind = item.get("@type")
            kinds = kind if isinstance(kind, list) else [kind]
            if any(str(value).lower() == "product" for value in kinds):
                products.append(item)
    return products


def currency_from(value: str) -> str:
    upper = value.upper()
    if "GBP" in upper or "£" in value or "&#163;" in value or "&POUND;" in upper:
        return "GBP"
    if "USD" in upper or "$" in value:
        return "USD"
    if "EUR" in upper or "€" in value or "&#8364;" in value or "&EURO;" in upper:
        return "EUR"
    return ""


def numeric_price(value: Any) -> float | None:
    match = re.search(r"(?<![\d.,])(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])", str(value or ""))
    if not match:
        return None
    raw = match.group(1)
    normalized = raw.replace(",", "") if "." in raw or re.fullmatch(r"\d{1,3}(?:,\d{3})+", raw) else raw.replace(",", ".")
    amount = float(normalized)
    return amount if amount > 0 else None


def first_text(values: list[str]) -> str:
    return next((re.sub(r"\s+", " ", value).strip() for value in values if value and value.strip()), "")


def identity(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", html_entities.unescape(value).lower()).strip()


def same_product_name(candidate: str, page_title: str) -> bool:
    left = identity(candidate)
    right = identity(page_title)
    return bool(left and right and (left == right or sorted(left.split()) == sorted(right.split())))


def scoped_price(node) -> tuple[float | None, str]:
    sale = node.xpath(".//ins")
    if sale:
        rendered = " ".join(sale[-1].itertext())
        return numeric_price(rendered), currency_from(rendered)
    amounts = []
    currencies = []
    price_nodes = node.xpath(".//*[contains(concat(' ', normalize-space(@class), ' '), ' woocommerce-Price-amount ')]")
    for price_node in price_nodes or [node]:
        rendered = " ".join(price_node.itertext())
        amount = numeric_price(rendered)
        currency = currency_from(rendered)
        if amount is not None:
            amounts.append(amount)
        if currency:
            currencies.append(currency)
    unique_amounts = sorted(set(amounts))
    unique_currencies = sorted(set(currencies))
    if len(unique_amounts) != 1 or len(unique_currencies) != 1:
        return None, ""
    return unique_amounts[0], unique_currencies[0]


def extract(document: str, url: str) -> tuple[str, float | None, str, str, str]:
    tree = html.fromstring(document)
    title = first_text(tree.xpath("//h1[contains(@class,'product_title')]//text()")) or first_text(tree.xpath("//h1//text()"))
    if not title:
        title = first_text(tree.xpath("//meta[@property='og:title']/@content")) or first_text(tree.xpath("//title/text()"))
        title = re.split(r"\s+[|–—]\s+", title, maxsplit=1)[0].strip()
    image = first_text(tree.xpath("//meta[@property='og:image']/@content"))
    for product in product_json_ld(document):
        name = str(product.get("name") or "").strip()
        if not same_product_name(name, title):
            continue
        offers = product.get("offers")
        offer_items = offers if isinstance(offers, list) else [offers]
        for offer in offer_items:
            if not isinstance(offer, dict):
                continue
            currency = str(offer.get("priceCurrency") or product.get("priceCurrency") or "").upper()
            for key in ("price",):
                amount = numeric_price(offer.get(key))
                if amount and currency:
                    product_image = product.get("image")
                    if isinstance(product_image, list):
                        product_image = product_image[0] if product_image else ""
                    elif isinstance(product_image, dict):
                        product_image = product_image.get("url") or product_image.get("contentUrl") or ""
                    return name or title, amount, currency, str(product_image or image), f"json-ld:{key}"

    scoped = tree.cssselect(".summary .price, .elementor-widget-wd_single_product_price .price")
    if scoped:
        amount, currency = scoped_price(scoped[0])
        if amount and currency:
            return title, amount, currency, image, "scoped-html-price"
    return title, None, "", image, ""


_ROBOTS: dict[str, urllib.robotparser.RobotFileParser | None] = {}


def robots_allowed(url: str) -> bool:
    origin = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}"
    if origin not in _ROBOTS:
        robots_url = f"{origin}/robots.txt"
        request = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT, "Accept": "text/plain"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                parser = urllib.robotparser.RobotFileParser(robots_url)
                parser.parse(response.read().decode("utf-8", errors="replace").splitlines())
                _ROBOTS[origin] = parser
        except Exception:
            _ROBOTS[origin] = None
    parser = _ROBOTS[origin]
    return bool(parser and parser.can_fetch(ROBOTS_AGENT, url))


def standard_fetch(url: str) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, response.read()


def scrapling_fetch(url: str) -> tuple[int, bytes]:
    response = Fetcher.get(url, impersonate="chrome", timeout=30)
    body = response.body if isinstance(response.body, bytes) else str(response.body).encode("utf-8")
    return response.status, body


def run(method: str, fetcher, url: str) -> Observation:
    started = time.perf_counter()
    try:
        status, body = fetcher(url)
        elapsed = time.perf_counter() - started
        document = body.decode("utf-8", errors="replace")
        title, price, currency, image, source = extract(document, url)
        return Observation(method, url, status, len(body), elapsed, title, price, currency, image, source)
    except Exception as error:
        return Observation(method, url, 0, 0, time.perf_counter() - started, "", None, "", "", "", f"{type(error).__name__}: {error}")


def summarize(items: list[Observation]) -> dict[str, Any]:
    timings = [item.seconds for item in items]
    return {
        "pages": len(items),
        "http_200": sum(item.status == 200 for item in items),
        "prices": sum(item.price is not None and bool(item.currency) for item in items),
        "images": sum(item.image.startswith("http") for item in items),
        "errors": sum(bool(item.error) for item in items),
        "median_seconds": round(statistics.median(timings), 3) if timings else None,
        "total_seconds": round(sum(timings), 3),
    }


def main() -> None:
    observations: list[Observation] = []
    for url in URLS:
        if not robots_allowed(url):
            raise RuntimeError(f"robots.txt did not allow benchmark route: {url}")
        observations.append(run("standard", standard_fetch, url))
        time.sleep(0.15)
        observations.append(run("scrapling", scrapling_fetch, url))
        time.sleep(0.15)
    methods = {
        method: summarize([item for item in observations if item.method == method])
        for method in ("standard", "scrapling")
    }
    paired = []
    for url in URLS:
        standard = next(item for item in observations if item.url == url and item.method == "standard")
        scrapling = next(item for item in observations if item.url == url and item.method == "scrapling")
        paired.append({
            "url": url,
            "robots_allowed": robots_allowed(url),
            "standard": asdict(standard),
            "scrapling": asdict(scrapling),
            "scrapling_added_price": standard.price is None and scrapling.price is not None,
            "scrapling_added_image": not standard.image and bool(scrapling.image),
        })
    rendered = json.dumps({"methods": methods, "paired": paired}, indent=2, ensure_ascii=False)
    output = os.environ.get("BENCHMARK_OUTPUT", "").strip()
    if output:
        Path(output).write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
