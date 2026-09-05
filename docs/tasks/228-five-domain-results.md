# Five-domain internal CLI acceptance — 5 September 2026

Worker **20260905.5**, source `60ba80ccda59fda15aec848f1a7cc43775794152`, pinned and unpromoted. The website and default worker were not changed. Each request asked for **20 priced comparison pairs and at most five rival sellers**. Pair count is not distinct-product count, exact-match certification, or a semantic quality score.

| Domain | Priced pairs | Primary products represented | Rival sellers | CLI time | Estimated OpenAI cost | Report status |
|---|---:|---:|---:|---:|---:|---|
| huel.com | 0/20 | 0 | 0 | 0m 06s | $0.000000 | limited |
| nativecos.com | 20/20 | 8 | 5 | 7m 08s | $2.247018 | limited |
| blueland.com | 13/20 | 2 | 5 | 1m 41s | $0.271934 | limited |
| stanley1913.com | 12/20 | 7 | 5 | 5m 52s | $1.139401 | limited |
| teapigs.co.uk | 0/20 | 0 | 0 | 0m 12s | $0.000000 | limited |

Recorded standard-price OpenAI estimate: **$3.65835270**. Unknown receipts: **0**. Not a settled invoice; Trigger compute is separate. Estimates use recorded GPT-5.4-mini input/cache/output tokens and search calls at [official OpenAI rates](https://developers.openai.com/api/docs/pricing). No independent paid evaluation was launched.

The original CLI JSON links below point to the operator's local machine, not files hosted by GitHub. The complete delivered comparison tables are included in this document; Trigger run links require project access.

## huel.com

Coverage failure: only five collection/category entries, none with prices; no AI search was started.

[Full original CLI JSON](<C:/tmp/market-signal-five-domain-20260905/five-domain-huel-com-mtok2qbd.result.json>) · [Trigger run](https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06g74g5fet272sg5hj89f69m01)

Integrity: 0/0 pairs have finite positive prices on both sides; 0/0 use the same currency; 0 self-domain pairs. Recorded AI searches: 0; repair rounds: 0.

| # | Primary product | Primary price | Rival product | Rival price | Rival source |
|---:|---|---:|---|---:|---|
| — | No priced comparisons delivered | — | — | — | — |

## nativecos.com

Count target reached, but not a quality pass: sunscreen is paired with shower oil, body wash and a face-care set. Bundle and pack-size differences also remain.

[Full original CLI JSON](<C:/tmp/market-signal-five-domain-20260905/five-domain-nativecos-com-mtok2qbd.result.json>) · [Trigger run](https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06g74g8p4jpfmj1d1r59oe1m01)

Integrity: 20/20 pairs have finite positive prices on both sides; 20/20 use the same currency; 0 self-domain pairs. Recorded AI searches: 75; repair rounds: 1.

| # | Primary product | Primary price | Rival product | Rival price | Rival source |
|---:|---|---:|---|---:|---|
| 1 | Body Sunscreen - Last Chance | USD 20 | Glow Restore Shower Oil | USD 16 | [athenaclub.com](https://athenaclub.com/products/shower-oil-almond-creme) |
| 2 | Body Lotion - Last Chance | USD 9.8 | Nourishing Body Lotion - Coconut Apricot | USD 14 | [bluatlas.com](https://bluatlas.com/products/nourishing-body-lotion-coconut-apricot) |
| 3 | Body Lotion | USD 14 | Natural Body Lotion | USD 20 | [bluatlas.com](https://bluatlas.com/products/body-lotion) |
| 4 | Body Wash | USD 11 | Best Spray-Tan Safe Body Wash | USD 24 | [scrubmegood.com](https://scrubmegood.com/products/eucalyptus-mint-ph-balance-body-wash) |
| 5 | Body Sunscreen - Last Chance | USD 20 | Summer Kit | USD 50 | [bluatlas.com](https://bluatlas.com/products/summer-kit) |
| 6 | Clean Hair Trio | USD 26.4 | Blonde Perfecting Purple Shampoo & Conditioner Bundle | USD 60 | [moroccanoil.com](https://www.moroccanoil.com/products/blonde-perfecting-purple-shampoo-conditioner-bundle) |
| 7 | Body Wash - Last Chance | USD 7.7 | Natural Body Wash | USD 20 | [bluatlas.com](https://bluatlas.com/products/body-wash) |
| 8 | Body Sunscreen - Last Chance | USD 20 | Skin Replenishing Body Wash | USD 12 | [athenaclub.com](https://athenaclub.com/products/skin-replenishing-body-wash-lavender-latte) |
| 9 | Body Sunscreen - Last Chance | USD 20 | Face Essentials (Cleanser + Moisturizer) | USD 35 | [bluatlas.com](https://bluatlas.com/products/face-essentials?variant=46725285904613) |
| 10 | Body Wash - Last Chance | USD 7.7 | Nourishing Hand & Body Wash | USD 32 | [cotebeauty.com](https://cotebeauty.com/products/nourishing-hand-body-wash) |
| 11 | Body Lotion | USD 14 | Body Lotion Spa Du Maroc | USD 30 | [moroccanoil.com](https://www.moroccanoil.com/products/body-lotion-spa-du-maroc) |
| 12 | Body Scrub - Last Chance | USD 7 | Gentle Exfoliating Scrub - Fragrance Free | USD 10 | [bluatlas.com](https://bluatlas.com/products/gentle-exfoliating-scrub-fragrance-free) |
| 13 | Body Wash - Last Chance | USD 7.7 | Body Wash - Coconut Apricot | USD 20 | [bluatlas.com](https://bluatlas.com/products/body-wash-coconut-apricot) |
| 14 | Body Lotion - Last Chance | USD 9.8 | Body Lotion Ambre Noir | USD 30 | [moroccanoil.com](https://www.moroccanoil.com/products/body-lotion-ambre-noir) |
| 15 | Clean Hair Trio | USD 26.4 | Hair Essentials Gift Set | USD 75 | [cotebeauty.com](https://cotebeauty.com/products/the-gift-of-hair-essentials) |
| 16 | Body Sunscreen - Last Chance | USD 20 | Lightweight Mineral SPF 30 | USD 20 | [bluatlas.com](https://bluatlas.com/products/lightweight-mineral-spf?variant=45950492213477) |
| 17 | Body Lotion - Last Chance | USD 9.8 | Mini Hydrating Hand & Body Lotion | USD 8 | [cotebeauty.com](https://cotebeauty.com/products/hand-body-lotion-travel-size-1-oz) |
| 18 | Body Scrub | USD 10 | Body Polishing Scrub | USD 32 | [moroccanoil.com](https://www.moroccanoil.com/products/body-polishing-scrub) |
| 19 | Body Scrub | USD 10 | Fragrance Free Exfoliating Body Scrub For Sensitive Skin | USD 19.5 | [scrubmegood.com](https://scrubmegood.com/products/sensitive-skin-exfoliating-sugar-scrub) |
| 20 | Body Lotion | USD 14 | Hydrating Hand & Body Lotion | USD 52 | [cotebeauty.com](https://cotebeauty.com/products/hydrating-hand-body-lotion) |

## blueland.com

Only two primary products represented. Several multi-item kits are compared with a single cleaner, a refill, or detergent only; these are not normalized like-for-like price comparisons.

[Full original CLI JSON](<C:/tmp/market-signal-five-domain-20260905/five-domain-blueland-com-mtok2qbd.result.json>) · [Trigger run](https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06g74i1pk5e533tn5nuck65c01)

Integrity: 13/13 pairs have finite positive prices on both sides; 13/13 use the same currency; 0 self-domain pairs. Recorded AI searches: 8; repair rounds: 3.

| # | Primary product | Primary price | Rival product | Rival price | Rival source |
|---:|---|---:|---|---:|---|
| 1 | Clean Essentials Kit | USD 46 | Foaming Hand Soap Starter Kit | USD 15 | [fabtab.com](https://fabtab.com/products/foaming-hand-soap-kit) |
| 2 | Clean Essentials Kit | USD 46 | Bathroom Cleaner Starter Kit | USD 20 | [fabtab.com](https://fabtab.com/products/bathroom-cleaner-starter-kit) |
| 3 | Laundry Essentials Kit | USD 51 | FREE Laundry for Life* | USD 99.99 | [cleanomic.com](https://cleanomic.com/products/free-laundry-for-life) |
| 4 | Laundry Essentials Kit | USD 51 | Complete Clean Kit | USD 71 | [ecokindcleaning.com](https://ecokindcleaning.com/en-us/products/complete-clean-kit) |
| 5 | Laundry Essentials Kit | USD 51 | Eco-Friendly Laundry Detergent Tablets (Fragrance Free) | USD 17 | [fabtab.com](https://fabtab.com/products/laundry-detergent-tabs-fragrance-free) |
| 6 | Laundry Essentials Kit | USD 51 | Dryer Sheets x2, Ocean Breeze x2, Stain Removal Kit x2, Color x2 Bundle | USD 9.5 | [cleanomic.com](https://cleanomic.com/products/bfcm-laundryessentialskit-offer) |
| 7 | Clean Essentials Kit | USD 46 | Multi-Purpose Cleaner Starter Kit | USD 20 | [fabtab.com](https://fabtab.com/products/multi-purpose-cleaner-starter-kit) |
| 8 | Clean Essentials Kit | USD 46 | Eco-Friendly Dazz Starter Kit with Reusable Sprays | USD 29.99 | [harmonyhome.jbachbrands.com](https://harmonyhome.jbachbrands.com/products/eco-friendly-dazz-starter-kit-with-reusable-sprays) |
| 9 | Clean Essentials Kit | USD 46 | Multi-Surface Starter Set | USD 19 | [ecokindcleaning.com](https://ecokindcleaning.com/en-us/products/multi-surface-starter-set) |
| 10 | Laundry Essentials Kit | USD 51 | Laundry Detergent Strips | USD 19 | [ecokindcleaning.com](https://ecokindcleaning.com/en-us/products/laundry-detergent-strips) |
| 11 | Clean Essentials Kit | USD 46 | Complete Home Starter Kit - Refill | USD 18 | [fabtab.com](https://fabtab.com/products/home-starter-kit-refill) |
| 12 | Clean Essentials Kit | USD 46 | Multi-Surface Cleaner Starter Kit | USD 18.95 | [buyblumix.com](https://www.buyblumix.com/products/multi-starter) |
| 13 | Laundry Essentials Kit | USD 51 | Laundry Detergent Tablets | USD 17 | [fabtab.com](https://fabtab.com/products/laundry-detergent-tabs-fresh-scent-pouch) |

## stanley1913.com

Several useful same-capacity food-jar and bottle alternatives, but only 12/20 pairs. All three repair attempts logged transport failure. Three rows compare a 36 oz bottle with 32 oz products. Seller authenticity was not independently established; source-linked price presence alone is not a trust endorsement.

[Full original CLI JSON](<C:/tmp/market-signal-five-domain-20260905/five-domain-stanley1913-com-mtok2qbd.result.json>) · [Trigger run](https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06g74imm4c4pqjdmcf58tuif01)

Integrity: 12/12 pairs have finite positive prices on both sides; 12/12 use the same currency; 0 self-domain pairs. Recorded AI searches: 34; repair rounds: 3.

| # | Primary product | Primary price | Rival product | Rival price | Rival source |
|---:|---|---:|---|---:|---|
| 1 | Adventure To-Go Food Jar + Spork \| 24 OZ | USD 28.5 | Stanley 1913 Adventure To-Go Food Jar + Spork \| 24 OZ | USD 10 | [vesselmerchant.shop](https://vesselmerchant.shop/products/stanley-1913-adventure-to-go-food-jar-spork-24-oz/) |
| 2 | Adventure To-Go Food Jar \| 18 OZ | USD 22.5 | 18 oz. Stainless Steel Food Jar SW-LA52H | USD 39.99 | [store.zojirushi.com](https://store.zojirushi.com/products/swla52h) |
| 3 | All Day Slim Bottle \| 20 OZ | USD 30 | Stanley 1913 All Day Slim Bottle 20 oz – Leakproof, Insulated, Sustainable | USD 15 | [vesselmerchant.shop](https://vesselmerchant.shop/products/stanley-1913-all-day-slim-bottle-20-oz-leakproof-insulated-sustainable/) |
| 4 | Adventure To-Go Food Jar + Spork \| 24 OZ | USD 28.5 | 24oz Icon™ Food Jar | USD 32.99 | [thermos.com](https://thermos.com/products/icon-food-jar-24oz) |
| 5 | Classic Legendary Camp Mug \| 12 OZ | USD 15 | Classic Legendary Camp Mug \| 12 oz | USD 20 | [advancedprimate.com](https://advancedprimate.com/products/classic-legendary-camp-mug-12-oz) |
| 6 | IceFlow™ Bottle with Fast Flow Lid \| 16 OZ | USD 30 | 16oz Stainless King™ Beverage Bottle | USD 29.99 | [thermos.com](https://thermos.com/products/stainless-king-beverage-bottle-16oz) |
| 7 | Adventure To-Go Bottle \| 25 OZ | USD 28 | 25 oz. Stainless Cool Bottle SD-KA75H | USD 46.99 | [store.zojirushi.com](https://store.zojirushi.com/products/sdka75h) |
| 8 | Adventure To-Go Food Jar \| 18 OZ | USD 22.5 | 18 oz. Stainless Steel Food Jar SW-KA52H | USD 39.99 | [store.zojirushi.com](https://store.zojirushi.com/products/swka52h) |
| 9 | IceFlow™ Bottle with Fast Flow Lid \| 36 OZ | USD 45 | 32oz Storage Bottle | USD 9.34 | [nalgene.com](https://nalgene.com/product/32oz-storage-bottle/) |
| 10 | IceFlow™ Bottle with Fast Flow Lid \| 36 OZ | USD 45 | 32oz Wide Mouth Large Logo | USD 17.99 | [nalgene.com](https://nalgene.com/product/32oz-wide-mouth-large-logo/) |
| 11 | IceFlow™ Bottle with Fast Flow Lid \| 36 OZ | USD 45 | 32oz Wide Mouth "Happy Gene" Bottle | USD 16.99 | [nalgene.com](https://nalgene.com/product/32oz-wide-mouth-happy-gene-tritan/) |
| 12 | IceFlow™ Bottle with Fast Flow Lid \| 16 OZ | USD 30 | 16oz FUNtainer® Water Bottle With Locking Lid | USD 18.99 | [thermos.com](https://thermos.com/products/16oz-funtainer-r-water-bottle-with-locking-lid) |

## teapigs.co.uk

Coverage failure: the crawl retained one unpriced subscription/category entry, not a priced tea product. No AI search was started.

[Full original CLI JSON](<C:/tmp/market-signal-five-domain-20260905/five-domain-teapigs-co-uk-mtok2qbd.result.json>) · [Trigger run](https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06g74k8mf4fffubvprja06fb01)

Integrity: 0/0 pairs have finite positive prices on both sides; 0/0 use the same currency; 0 self-domain pairs. Recorded AI searches: 0; repair rounds: 0.

| # | Primary product | Primary price | Rival product | Rival price | Rival source |
|---:|---|---:|---|---:|---|
| — | No priced comparisons delivered | — | — | — | — |


