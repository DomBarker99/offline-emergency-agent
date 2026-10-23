"""
draft_cards.py: draft short life-safety ACTION CARDS from the library, for a person to review.

WHERE THIS FITS
  Runs after extract.py, at build time (online). Output feeds the agent's safety router:
  data/cards/library-cards.json  ->  src/core/knowledge-cognee.ts (pinned when a danger is detected)

WHY CARDS EXIST NEXT TO THE LIBRARY
  The library answers almost anything, but in the first seconds of a flood, fire, gas leak, earthquake,
  heat stroke or carbon-monoxide risk, the agent must always show the protective action first, even if
  search is slow or picks the wrong page. A card is a handful of sentences for one danger.

HOW A CARD IS DRAFTED (and why it stays "vetted")
  1. Candidate passages: library passages tagged with the danger's hazard, preferring "during" guidance
     from federal or state publishers.
  2. The build model (frontier, via BUILD_LLM_* in .env) is asked to SELECT sentences, copied exactly,
     that tell a person what to do right now. It may not write new text.
  3. Every selected sentence is checked to appear word-for-word in its passage; anything else is dropped.
  4. The card records exactly which passage each sentence came from and is marked "reviewed": false.
     A person reviews and flips it to true (see docs/KNOWLEDGE.md).

USAGE
  uv run --env-file ../.env python draft_cards.py --out ../data/cards/library-cards.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from openai import OpenAI

# One card per danger rule scenario in src/core/safety.ts.
CARD_SPECS = [
    {"id": "C1", "scenario": "flood", "hazard": "flood", "title": "Flood: protect yourself now",
     "focus": "what to do when water is rising or the street is flooding: moving to higher ground, never walking or driving through flood water, evacuating if told to.",
     "keywords": ["turn around", "drown", "higher ground", "flood water", "floodwater", "evacuate", "drive", "walk", "moving water"]},
    {"id": "C2", "scenario": "gas", "hazard": "earthquake", "title": "Gas smell or leak",
     "focus": "what to do if you smell gas or suspect a gas leak (especially after an earthquake): leaving, not using switches or flames, who to call, when to shut off gas.",
     "keywords": ["smell gas", "gas leak", "hissing", "shut off", "gas", "spark", "flame", "utility", "leave"]},
    {"id": "C3", "scenario": "fire", "hazard": "wildfire", "title": "Wildfire or smoke: act now",
     "focus": "what to do when a wildfire threatens or an evacuation order is given, and how to protect yourself from heavy smoke.",
     "keywords": ["evacuat", "leave", "go!", "wildfire", "smoke", "n95", "indoors", "windows", "trapped"]},
    {"id": "C4", "scenario": "power-outage", "hazard": "power-outage", "title": "Power outage: carbon monoxide and food",
     "focus": "carbon monoxide safety with generators, grills and camp stoves during an outage (never indoors or in a garage), plus keeping fridge and freezer closed.",
     "keywords": ["generator", "carbon monoxide", "garage", "indoors", "grill", "camp stove", "refrigerator", "freezer", "closed", "20 feet"]},
    {"id": "C5", "scenario": "earthquake", "hazard": "earthquake", "title": "Earthquake: drop, cover, hold on",
     "focus": "what to do during shaking (drop, cover, hold on; stay where you are) and right after it stops (injuries, hazards, aftershocks).",
     "keywords": ["drop", "cover", "hold on", "shaking", "table", "doorway", "aftershock", "stay", "bed"]},
    {"id": "C6", "scenario": "extreme-heat", "hazard": "extreme-heat", "title": "Heat illness: act now",
     "focus": "recognizing heat stroke versus heat exhaustion and what to do immediately (call 911 for heat stroke, cool the person).",
     "keywords": ["heat stroke", "heat exhaustion", "911", "cool", "sweat", "confusion", "body temperature", "cool water"]},
]

def norm(s: str) -> str:
    """Whitespace- and markup-insensitive form used to check that a quote is verbatim."""
    s = re.sub(r"[*_`>#]", "", s)
    s = s.replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


def candidates(passages: list[dict], spec: dict, n: int = 16) -> list[dict]:
    """The passages most likely to hold immediate actions for this danger.
    Score = focus keywords in the heading/title (x3) and text (x1), plus a bonus for "during" guidance
    and for federal/state publishers. At most 3 passages per page, so several publishers are seen."""
    hz = spec["hazard"]
    def score(p):
        head = f"{p['pageTitle']} {p['heading']}".lower()
        body = p["text"].lower()
        s = sum(3 * head.count(k) + body.count(k) for k in spec["keywords"])
        s += 4 if hz in p["hazards"] else 0
        s += 3 if "during" in p["phases"] else 0
        s += {"federal": 2, "state": 1}.get(p["tier"], 0)
        return s
    ranked = sorted(passages, key=score, reverse=True)
    out, per_page = [], {}
    for p in ranked:
        if per_page.get(p["url"], 0) >= 3:
            continue
        per_page[p["url"]] = per_page.get(p["url"], 0) + 1
        out.append(p)
        if len(out) >= n:
            break
    return out


def draft(client: OpenAI, model: str, effort: str, spec: dict, cands: list[dict]) -> list[dict]:
    """Ask the build model to pick verbatim sentences. Returns [{passage_id, quote}]."""
    listing = "\n\n".join(f"<passage id=\"{p['id']}\" publisher=\"{p['publisher']}\">\n{p['text']}\n</passage>" for p in cands)
    prompt = (
        "You help build an offline emergency card from OFFICIAL text. You must not write any new words.\n"
        f"Topic: {spec['focus']}\n\n"
        "From the passages below, select 3 to 6 sentences or list items that tell a person what to do RIGHT NOW. "
        "Copy each one EXACTLY as written (same words, you may drop leading bullet characters). "
        "Prefer one publisher when possible. Order them from most to least urgent.\n"
        "Return JSON: {\"quotes\": [{\"passage_id\": \"...\", \"quote\": \"...\"}]}\n\n" + listing
    )
    kwargs = {"reasoning_effort": effort} if effort else {}
    resp = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt}],
                                          response_format={"type": "json_object"}, **kwargs)
    return json.loads(resp.choices[0].message.content).get("quotes", [])


def main() -> int:
    ap = argparse.ArgumentParser(description="Draft action cards from the library (for human review).")
    ap.add_argument("--corpus", default=os.environ.get("CORPUS_DIR"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    passages = [json.loads(l) for l in open(Path(args.corpus) / "passages.jsonl")]
    by_id = {p["id"]: p for p in passages}
    client = OpenAI(base_url=os.environ["BUILD_LLM_BASE_URL"], api_key=os.environ["BUILD_LLM_API_KEY"])
    model = os.environ.get("BUILD_LLM_MODEL", "gpt-6.1-sol")
    effort = os.environ.get("BUILD_LLM_REASONING_EFFORT", "")

    cards = []
    for spec in CARD_SPECS:
        cands = candidates(passages, spec)
        quotes = draft(client, model, effort, spec, cands)
        kept, dropped = [], []
        for q in quotes:
            p = by_id.get(q.get("passage_id", ""))
            text = re.sub(r"^\s*[-\u2022*\d.)]+\s*", "", q.get("quote", "")).strip()
            # Drop Markdown emphasis marks the page used for bold text; the words stay identical.
            text = re.sub(r"\*\*|__|(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)", "", text).strip()
            if text.endswith(":"):
                # An introduction to a list ("...by doing the following:") is not an action by itself.
                dropped.append(q)
                continue
            if p and text and norm(text) in norm(p["text"]):
                kept.append({"passageId": p["id"], "quote": text})
            else:
                dropped.append(q)
        if not kept:
            print(f"{spec['id']}: no verbatim quotes survived; skipping", file=sys.stderr)
            continue
        main_p = by_id[kept[0]["passageId"]]
        cards.append({
            "id": spec["id"], "title": spec["title"], "scenarios": [spec["scenario"]], "danger": "immediate",
            "body": " ".join(k["quote"] if k["quote"].endswith((".", "!", "?")) else k["quote"] + "." for k in kept),
            "source": {"name": main_p["publisher"], "url": main_p["url"], "retrieved": main_p["fetchedAt"][:10],
                       "updated": main_p.get("pageDate") or None},
            "reviewed": False,
            "quotes": [{**k, "url": by_id[k["passageId"]]["url"], "publisher": by_id[k["passageId"]]["publisher"]} for k in kept],
            "droppedQuotes": len(dropped),
            "draftedBy": f"{model} (selection only; every sentence checked verbatim against its passage)",
        })
        print(f"{spec['id']} {spec['title']}: {len(kept)} quotes kept, {len(dropped)} dropped", flush=True)
    Path(args.out).write_text(json.dumps(cards, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(cards)} cards -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
