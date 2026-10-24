"""
extract.py: split captured pages into short, citable passages and tag them with topics.

WHERE THIS FITS
  Step 2 of the knowledge pipeline:  collect.py -> extract.py -> (npm run embed, and build_pack.py)
  Input:  <corpus>/raw/*/*/meta.json + page.md / document.md   (written by collect.py)
  Output: <corpus>/passages.jsonl   one passage per line (the unit the agent retrieves and cites)
          <corpus>/COVERAGE.md      the topic grid: how many passages cover each hazard, need and phase

WHAT A PASSAGE IS
  A section of one official page (a heading plus the text under it), around 60 to 350 words.
  The text is the publisher's own words. We only remove Markdown link targets ("[label](url)" -> "label")
  and page furniture; we never reword. Each passage keeps: its source, URL, heading path, the date the
  page shows, when we fetched it, and topic tags (hazards, needs, phases) from knowledge/topics.json.

  Passage IDs look like "ready-gov:floods:3" (source : page : section number). They are stable as long
  as the page itself doesn't change, and the agent cites them in square brackets.

USAGE
  uv run --env-file ../.env python extract.py            # uses $CORPUS_DIR
  uv run python extract.py --corpus /path/to/corpus
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from collect import normalize_date  # same date parsing as the collector

HERE = Path(__file__).resolve().parent

MAX_WORDS = 350      # split sections longer than this
MIN_WORDS = 25       # passages shorter than this are merged into a neighbour (or dropped if alone)
LINK_ONLY_SHARE = 0.7  # a section whose lines are mostly links is a "related links" list: not guidance

LINK_RE = re.compile(r"\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)")

# Whole lines that are page furniture, not guidance (language switchers, audience labels, share buttons).
# Only exact, short lines are removed, so real sentences are never touched.
FURNITURE_LINE = re.compile(
    r"(?i)^\s*(espa\u00f1ol|english|for everyone|print|share|facebook|twitter|x|linkedin|email|on this page|"
    r"image|related pages|related links|back to top|top of page|\w{3,9}\.? \d{1,2}, \d{4},? visit link for details\.?)\s*$")


def plain_links(md: str) -> str:
    """'[Make a Plan](https://...)' -> 'Make a Plan'. Keeps the words a reader sees, drops URLs."""
    return LINK_RE.sub(lambda m: m.group(1), md)


def is_link_list(lines: list[str]) -> bool:
    """True when most non-empty lines are just a link (navigation-like lists)."""
    content = [l for l in lines if l.strip()]
    if not content:
        return True
    # A line is "linky" when nothing but links (and bullet/separator characters) is left on it,
    # e.g. "- [Floods](...)" or a tab menu "[Flood Safety](...)[Turn Around Don't Drown](...)".
    linky = sum(1 for l in content if "](" in l and not LINK_RE.sub("", l).strip(" \t-*|\u00b7\u2022.,"))
    return linky / len(content) >= LINK_ONLY_SHARE


def split_sections(md: str) -> list[tuple[list[str], list[str]]]:
    """Markdown -> [(heading_path, body_lines)]. A new section starts at every heading.
    heading_path is the chain of headings above the section, e.g. ['Floods', 'Prepare NOW']."""
    sections: list[tuple[list[str], list[str]]] = []
    path: list[tuple[int, str]] = []
    body: list[str] = []

    def flush():
        if body and any(l.strip() for l in body):
            sections.append(([h for _, h in path], body.copy()))
        body.clear()

    for line in md.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*\S)\s*$", line)
        if m:
            flush()
            level, title = len(m.group(1)), plain_links(m.group(2)).strip("*_ ")
            path = [(l, t) for l, t in path if l < level] + [(level, title)]
        else:
            body.append(line)
    flush()
    return sections


def split_long_block(block: str) -> list[str]:
    """A single paragraph longer than MAX_WORDS (common in PDFs) is split at line breaks, then at
    sentence ends, so no piece is much longer than MAX_WORDS."""
    if len(block.split()) <= MAX_WORDS:
        return [block]
    units = block.split("\n") if block.count("\n") >= 3 else re.split(r"(?<=[.!?])\s+", block)
    out, cur, n = [], [], 0
    for u in units:
        w = len(u.split())
        if cur and n + w > MAX_WORDS:
            out.append("\n".join(cur))
            cur, n = [], 0
        cur.append(u)
        n += w
    if cur:
        out.append("\n".join(cur))
    return out


def chunk_body(text: str) -> list[str]:
    """Split a long section at paragraph/list boundaries into pieces of at most ~MAX_WORDS words."""
    blocks = [piece for b in re.split(r"\n\s*\n", text) if b.strip() for piece in split_long_block(b.strip())]
    out, cur, n = [], [], 0
    for b in blocks:
        w = len(b.split())
        if cur and n + w > MAX_WORDS:
            out.append("\n\n".join(cur))
            cur, n = [], 0
        cur.append(b)
        n += w
    if cur:
        out.append("\n\n".join(cur))
    return out


def load_topics() -> dict:
    return json.loads((HERE / "topics.json").read_text())


def tag(topics: dict, strong_text: str, body: str) -> dict[str, list[str]]:
    """Topic tags for one passage. strong_text = URL + title + heading (one match is enough);
    body = passage text (needs topics['minBodyHits'] matches)."""
    strong, low = strong_text.lower(), body.lower()
    result = {}
    for group in ("hazards", "needs", "phases"):
        hits = []
        for name, kws in topics[group].items():
            pats = [re.compile(r"(?<![a-z])" + re.escape(k) + r"(?![a-z])") for k in kws]
            if group == "phases":
                # Phases are judged from headings only: body words like "after" are too common.
                if any(p.search(strong) for p in pats):
                    hits.append(name)
                continue
            if any(p.search(strong) for p in pats) or sum(len(p.findall(low)) for p in pats) >= topics["minBodyHits"]:
                hits.append(name)
        result[group] = hits
    return result


def page_date(meta: dict) -> str | None:
    for d in (meta.get("datesPrinted") or []) + (meta.get("datesMeta") or []):
        nd = normalize_date(d.get("value", ""))
        if nd:
            return nd
    return None


def passages_for(meta: dict, md: str, topics: dict) -> list[dict]:
    """All passages of one captured item."""
    slug = Path(meta["folder"]).name
    title = (meta.get("h1") or meta.get("title") or "").strip()
    base = {"sourceId": meta["sourceId"], "publisher": meta["publisher"], "tier": meta["tier"],
            "jurisdiction": meta["jurisdiction"], "url": meta["url"], "pageTitle": title,
            "pageDate": page_date(meta), "fetchedAt": meta["fetchedAt"], "kind": meta["kind"],
            "folder": meta["folder"]}

    # Drop the header lines collect.py adds (Source:/URL:) so they don't end up in passages.
    md = re.sub(r"(?m)^(Source|URL): .*$", "", md)

    raw_sections: list[tuple[list[str], str]] = []
    if meta["kind"] == "document":
        # PDFs: no reliable headings. Split per page marker, then by size.
        pages = re.split(r"<!-- page (\d+) -->", md)
        for i in range(1, len(pages), 2):
            raw_sections.append(([title, f"page {pages[i]}"], pages[i + 1]))
    else:
        for path, lines in split_sections(md):
            if is_link_list(lines):
                continue
            raw_sections.append((path, "\n".join(lines)))

    # Clean and split long sections.
    pieces: list[tuple[list[str], str]] = []
    for path, text in raw_sections:
        text = plain_links(text)
        text = "\n".join(l for l in text.splitlines() if not FURNITURE_LINE.match(l))
        if meta["kind"] == "document":
            # PDF text breaks lines at the page edge. Re-join wrapped lines (a line break that isn't
            # followed by a bullet or a blank line), and re-join words hyphenated across lines.
            text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
            text = re.sub(r"(?<!\n)\n(?![\n\u2022\-\u25cf\u25aa\d])", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if not text:
            continue
        for part in chunk_body(text):
            pieces.append((path, part))

    # Merge passages that are too short into the next one with the same top-level heading.
    merged: list[tuple[list[str], str]] = []
    for path, text in pieces:
        if merged and len(merged[-1][1].split()) < MIN_WORDS and merged[-1][0][:1] == path[:1] \
                and len(merged[-1][1].split()) + len(text.split()) <= MAX_WORDS:
            prev_path, prev_text = merged.pop()
            heading_line = " > ".join(path[len(prev_path) - 1:]) if path != prev_path else ""
            text = prev_text + ("\n\n" + heading_line + "\n" if heading_line else "\n\n") + text
            path = prev_path
        merged.append((path, text))

    out = []
    for n, (path, text) in enumerate(merged, start=1):
        words = len(text.split())
        if words < 8:  # fragments like a lone date line
            continue
        heading = " > ".join(h for h in path if h)
        tags = tag(topics, f"{meta['url']} {title} {heading}", text)
        out.append({**base, "id": f"{meta['sourceId']}:{slug}:{n}", "heading": heading, "text": text,
                    "words": words, **tags})
    return out


def coverage_report(passages: list[dict], topics: dict) -> str:
    """Markdown tables: passages per hazard x phase, and per need. Empty cells show what's missing."""
    lines = ["# Coverage of the topic grid", "",
             f"{len(passages):,} passages from {len({p['url'] for p in passages}):,} pages and documents. "
             "Counts are passages tagged with each topic (one passage can count in several cells). "
             "Generated by `knowledge/extract.py` from `knowledge/topics.json`.", "",
             "## Hazards by phase", "", "| Hazard | Before | During | After | Any phase | Sources |", "| --- | ---: | ---: | ---: | ---: | --- |"]
    for hz in topics["hazards"]:
        ps = [p for p in passages if hz in p["hazards"]]
        cnt = {ph: sum(1 for p in ps if ph in p["phases"]) for ph in topics["phases"]}
        srcs = ", ".join(f"{s} ({c})" for s, c in Counter(p["sourceId"] for p in ps).most_common())
        lines.append(f"| {hz} | {cnt['before']} | {cnt['during']} | {cnt['after']} | {len(ps)} | {srcs} |")
    lines += ["", "## Needs", "", "| Need | Passages | Sources |", "| --- | ---: | --- |"]
    for nd in topics["needs"]:
        ps = [p for p in passages if nd in p["needs"]]
        srcs = ", ".join(f"{s} ({c})" for s, c in Counter(p["sourceId"] for p in ps).most_common())
        lines.append(f"| {nd} | {len(ps)} | {srcs} |")
    weak = [hz for hz in topics["hazards"] if sum(1 for p in passages if hz in p["hazards"]) < 5]
    lines += ["", "## Thin cells", "", "Hazards with fewer than 5 passages: " + (", ".join(weak) if weak else "none") + "."]
    by_src = Counter(p["sourceId"] for p in passages)
    lines += ["", "## Passages per source", "", "| Source | Passages | Words |", "| --- | ---: | ---: |"]
    for s, c in by_src.most_common():
        lines.append(f"| {s} | {c} | {sum(p['words'] for p in passages if p['sourceId'] == s):,} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Split captured pages into tagged passages.")
    ap.add_argument("--corpus", default=os.environ.get("CORPUS_DIR"))
    args = ap.parse_args()
    if not args.corpus:
        sys.exit("Set CORPUS_DIR (e.g. in .env) or pass --corpus.")
    corpus = Path(args.corpus).expanduser()
    topics = load_topics()
    passages: list[dict] = []
    seen_text: dict[str, str] = {}
    dupes = 0
    for mp in sorted((corpus / "raw").glob("*/*/meta.json")):
        meta = json.loads(mp.read_text())
        if meta.get("status") != "ok":
            continue
        meta["folder"] = str(mp.parent.relative_to(corpus))
        md_file = mp.parent / ("document.md" if meta["kind"] == "document" else "page.md")
        for p in passages_for(meta, md_file.read_text(), topics):
            # The same boilerplate paragraph can appear on many pages of one site. Keep the first copy.
            key = re.sub(r"\W+", " ", p["text"].lower()).strip()
            if key in seen_text:
                dupes += 1
                continue
            seen_text[key] = p["id"]
            passages.append(p)
    with open(corpus / "passages.jsonl", "w") as f:
        for p in passages:
            f.write(json.dumps(p) + "\n")
    (corpus / "COVERAGE.md").write_text(coverage_report(passages, topics))
    print(f"{len(passages)} passages ({dupes} duplicate passages skipped) -> {corpus / 'passages.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
