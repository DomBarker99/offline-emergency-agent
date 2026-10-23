"""
collect.py: capture official emergency-guidance pages into the raw library.

WHERE THIS FITS
  Step 1 of the knowledge pipeline (see docs/KNOWLEDGE.md):
    collect.py  ->  extract.py  ->  build_pack.py  ->  serve.py (read-only, used by the chat agent)
  This script only captures. It never edits or summarizes what a publisher wrote.

WHAT IT PRODUCES (one folder per page, under <corpus>/raw/<source-id>/<slug>/)
  page.raw.html       the HTML exactly as the server sent it
  page.rendered.html  the page after the browser ran its scripts (what a person actually sees)
  page.pdf            the page printed by Chrome, for checking by eye (headless mode)
  page.png            a full-page screenshot instead, when the site needs a visible browser window
  page.md             the main content converted to Markdown (navigation, header and footer removed)
  meta.json           URL, publisher, fetch time, dates found on the page, file hashes, extraction check
  For PDFs:  document.pdf (the original file), document.md (its text), meta.json
  Plus <corpus>/manifest.jsonl (one line per captured item) and <corpus>/COLLECTION-REPORT.md.

HOW "EXTRACTED CORRECTLY" IS CHECKED
  For every page we compare the words a reader can see in the main content area with the words in
  page.md. "coverage" = share of visible words that made it into page.md. Pages below 0.95 are flagged
  in the report so a person can open page.pdf next to page.md and look.

HOW "UP TO DATE" IS RECORDED
  We store the fetch time, the server's Last-Modified header, and any "Last updated / Last reviewed /
  Content current as of" date printed on the page or in its metadata.

USAGE
  uv run --env-file ../.env python collect.py                 # all sources (CORPUS_DIR from .env)
  uv run python collect.py --corpus /path/to/corpus --only cdc --force
  Options: --only <id,...>  limit to some sources;  --force  recapture pages already captured;
           --report-only    just rebuild manifest.jsonl and the report from existing meta.json files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

from markdownify import markdownify
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent

# Seconds to wait between requests to the same host. Keeps us polite to public sites.
PER_HOST_DELAY = 1.5

# Pages whose extracted text covers less than this share of the visible words get flagged for review.
COVERAGE_FLAG = 0.95

# Elements removed from the main content before converting to Markdown. These are page furniture,
# not guidance. (We do NOT remove hidden elements: collapsed accordions often hold real guidance.)
CLEANUP_JS = r"""
(selectors) => {
  // Find the main content area: the first selector that matches an element with real text.
  let root = null;
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && (el.innerText || '').trim().length > 200) { root = el; break; }
  }
  const usedSelector = root ? selectors.find(s => document.querySelector(s) === root) : 'body';
  if (!root) root = document.body;

  // What a reader sees in that area, measured BEFORE cleanup (used for the coverage check).
  const visibleText = root.innerText || '';

  const drop = [
    'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button',
    'nav', 'footer', 'aside', '[role=navigation]', '[role=search]', '[aria-hidden=true] svg',
    '.breadcrumb', '.breadcrumbs', '[class*=breadcrumb]', '[class*=share]', '[class*=social]',
    '[class*=skip-link]', '[class*=feedback]', '.visually-hidden-focusable'
  ];
  // Visible text inside the elements we deliberately drop (navigation etc.). The coverage check
  // leaves these words out, so it measures conversion loss, not intended cleanup.
  const droppedText = drop.flatMap(sel => Array.from(root.querySelectorAll(sel))).map(n => n.innerText || '').join('\n');

  // Work on a copy so the live page (and the saved rendered HTML) stays untouched.
  const copy = root.cloneNode(true);
  for (const sel of drop) copy.querySelectorAll(sel).forEach(n => n.remove());
  // Open <details> so their content is kept.
  copy.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  // Make links absolute so citations still work offline.
  copy.querySelectorAll('a[href]').forEach(a => { try { a.setAttribute('href', new URL(a.getAttribute('href'), location.href).href); } catch (e) {} });

  // Date candidates: printed on the page, or in metadata.
  const bodyText = document.body.innerText || '';
  const dateRe = /(Last\s+(?:Updated|Reviewed|Modified)(?:\s+on)?|Page\s+last\s+(?:reviewed|updated)|Content\s+current\s+as\s+of|Updated(?:\s+on)?|Reviewed)\s*[:\-]?\s*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/gi;
  const printed = [];
  let m; while ((m = dateRe.exec(bodyText)) && printed.length < 5) printed.push({label: m[1], value: m[2]});
  const metaDates = [];
  for (const n of ['article:modified_time', 'og:updated_time', 'dcterms.modified', 'DC.date.modified', 'last-modified', 'dateModified', 'article:published_time', 'cdc:last_updated', 'cdc:last_reviewed']) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    if (el && el.content) metaDates.push({label: n, value: el.content});
  }
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      const items = Array.isArray(j) ? j : (j['@graph'] || [j]);
      for (const it of items) if (it && it.dateModified) metaDates.push({label: 'ld+json dateModified', value: it.dateModified});
    } catch (e) {}
  }
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
  const h1 = (document.querySelector('h1') || {}).innerText || '';
  return {html: copy.outerHTML, visibleText, droppedText, usedSelector, printed, metaDates, links, h1};
}
"""

BLOCKED_TITLES = re.compile(r"(?i)(access denied|request could not be satisfied|page not found|404|forbidden|just a moment|attention required)")


@dataclass
class Item:
    """One URL waiting to be captured, with how many link hops it is from a seed."""
    url: str
    depth: int


@dataclass
class Stats:
    captured: int = 0
    skipped_existing: int = 0
    failed: int = 0
    failures: list = field(default_factory=list)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_url(url: str) -> str:
    """Drop #fragments and query strings so the same page isn't captured twice."""
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc.lower(), p.path, "", "", ""))


def slug_for(url: str) -> str:
    """Folder name for a URL: its path with '/' turned into '__'. Readable and unique per source."""
    p = urlparse(url)
    path = p.path.strip("/") or "home"
    path = re.sub(r"\.(html?|aspx)$", "", path)
    s = re.sub(r"[^A-Za-z0-9._-]+", "__", path).strip("_")
    if len(s) > 120:  # very long paths: keep the readable start, add a short hash for uniqueness
        s = s[:100] + "-" + hashlib.sha1(path.encode()).hexdigest()[:8]
    return s


def words(text: str) -> set[str]:
    """Lowercase words of 4+ letters. Used to measure how much visible text made it into the Markdown."""
    return {w for w in re.findall(r"[a-z][a-z'\-]{3,}", text.lower())}


def to_markdown(html: str) -> str:
    """HTML of the cleaned main content -> Markdown. Headings become '#' lines, lists stay lists."""
    md = markdownify(html, heading_style="ATX", bullets="-", strip=["img"])
    md = re.sub(r"[ \t]+\n", "\n", md)          # trailing spaces
    md = re.sub(r"\n{3,}", "\n\n", md)          # runs of blank lines
    return md.strip() + "\n"


def matches_any(patterns: list[str], text: str) -> bool:
    return any(re.search(p, text) for p in patterns)


class Collector:
    """Owns the browsers and writes captures to disk. One instance per run."""

    def __init__(self, corpus: Path, force: bool):
        self.corpus = corpus
        self.raw = corpus / "raw"
        self.force = force
        self.last_hit: dict[str, float] = {}
        self.pw = sync_playwright().start()
        self.browsers: dict[str, Browser] = {}
        self.contexts: dict[str, BrowserContext] = {}

    # --- browser management -------------------------------------------------------------------
    def context(self, mode: str) -> BrowserContext:
        """A browser context for 'headless' or 'headed' mode, created on first use.
        Uses the locally installed Google Chrome (channel='chrome'), so nothing extra is downloaded."""
        if mode not in self.contexts:
            browser = self.pw.chromium.launch(channel="chrome", headless=(mode == "headless"))
            self.browsers[mode] = browser
            self.contexts[mode] = browser.new_context(viewport={"width": 1280, "height": 1600}, locale="en-US",
                                                      accept_downloads=True)
        return self.contexts[mode]

    def close(self) -> None:
        for b in self.browsers.values():
            b.close()
        self.pw.stop()

    def polite_wait(self, url: str) -> None:
        host = urlparse(url).netloc
        wait = PER_HOST_DELAY - (time.time() - self.last_hit.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        self.last_hit[host] = time.time()

    # --- one HTML page -------------------------------------------------------------------------
    def capture_page(self, src: dict, url: str) -> dict:
        """Load one page, save all its files, return its metadata (also written to meta.json).
        Never raises for a bad page: failures come back as {'status': 'failed', 'error': ...}."""
        mode = src.get("browser", "headless")
        out = self.raw / src["id"] / slug_for(url)
        meta_path = out / "meta.json"
        if meta_path.exists() and not self.force:
            old = json.loads(meta_path.read_text())
            if old.get("status") == "ok":
                old["_skipped"] = True
                return old

        self.polite_wait(url)
        page: Page = self.context(mode).new_page()
        meta: dict = {"kind": "page", "sourceId": src["id"], "publisher": src["publisher"],
                      "jurisdiction": src["jurisdiction"], "tier": src["tier"], "url": url,
                      "fetchedAt": now_iso(), "browser": mode}
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass  # some sites keep connections open forever; the content is there anyway
            status = resp.status if resp else 0
            title = page.title()
            meta.update({"httpStatus": status, "finalUrl": page.url, "title": title,
                         "httpLastModified": (resp.headers.get("last-modified") if resp else None)})
            if status >= 400 or BLOCKED_TITLES.search(title or ""):
                raise RuntimeError(f"blocked or missing page (HTTP {status}, title {title!r})")

            raw_html = resp.body() if resp else b""
            rendered = page.content().encode("utf-8")
            info = page.evaluate(CLEANUP_JS, src.get("mainSelectors", ["main"]))
            md_body = to_markdown(info["html"])
            header = f"# {info['h1'].strip() or title}\n\nSource: {src['publisher']}  \nURL: {url}  \n"
            md = md_body if md_body.lstrip().startswith("# ") else header + "\n" + md_body

            dropped = words(info["droppedText"])
            visible = words(info["visibleText"]) - dropped  # words the reader sees in content, not navigation
            got = words(md)
            coverage = round(len(visible & got) / len(visible), 4) if visible else 0.0
            missing = sorted(visible - got)[:40]

            out.mkdir(parents=True, exist_ok=True)
            (out / "page.raw.html").write_bytes(raw_html)
            (out / "page.rendered.html").write_bytes(rendered)
            (out / "page.md").write_text(md)
            visual_name = "page.pdf" if mode == "headless" else "page.png"
            if mode == "headless":
                page.emulate_media(media="screen")  # print what the screen shows, not the print stylesheet
                page.pdf(path=str(out / visual_name), format="Letter", print_background=True,
                         margin={"top": "0.4in", "bottom": "0.4in", "left": "0.4in", "right": "0.4in"})
            else:
                page.screenshot(path=str(out / visual_name), full_page=True)

            meta.update({
                "status": "ok",
                "h1": info["h1"].strip(),
                "mainSelector": info["usedSelector"],
                "datesPrinted": info["printed"],
                "datesMeta": info["metaDates"],
                "visual": visual_name,
                "words": len(md.split()),
                "check": {"coverage": coverage, "visibleWords": len(visible), "flagged": coverage < COVERAGE_FLAG,
                          "missingSample": missing, "droppedAsFurnitureSample": sorted(dropped)[:25]},
                "sha256": {"page.raw.html": sha256_bytes(raw_html), "page.rendered.html": sha256_bytes(rendered),
                           "page.md": sha256_bytes(md.encode()), visual_name: sha256_bytes((out / visual_name).read_bytes())},
                "_links": info["links"],
            })
        except Exception as e:  # record the failure; the run continues with the next page
            meta.update({"status": "failed", "error": str(e)[:500]})
        finally:
            page.close()

        links = meta.pop("_links", [])
        out.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(meta, indent=2))
        meta["_links"] = links
        return meta

    # --- one PDF -------------------------------------------------------------------------------
    def capture_pdf(self, doc: dict, mode: str) -> dict:
        """Download a PDF through the browser (so bot checks pass), save it and its extracted text.
        Plain text extraction first (pypdf). If the text looks garbled the item is flagged; docling
        can then be run on just that file (see extract.py --docling)."""
        out = self.raw / doc["sourceId"] / ("doc__" + slug_for(doc["url"]))
        meta_path = out / "meta.json"
        if meta_path.exists() and not self.force:
            old = json.loads(meta_path.read_text())
            if old.get("status") == "ok":
                old["_skipped"] = True
                return old
        self.polite_wait(doc["url"])
        meta = {"kind": "document", "sourceId": doc["sourceId"], "publisher": doc["publisher"],
                "jurisdiction": doc["jurisdiction"], "tier": doc["tier"], "url": doc["url"],
                "title": doc.get("title", ""), "fetchedAt": now_iso(), "note": doc.get("note", "")}
        try:
            resp = self.context(mode).request.get(doc["url"], timeout=120000)
            data = resp.body()
            meta.update({"httpStatus": resp.status, "httpLastModified": resp.headers.get("last-modified")})
            if resp.status >= 400 or not data.startswith(b"%PDF"):
                raise RuntimeError(f"not a PDF (HTTP {resp.status}, {len(data)} bytes)")
            out.mkdir(parents=True, exist_ok=True)
            (out / "document.pdf").write_bytes(data)
            reader = PdfReader(out / "document.pdf")
            pages = [(p.extract_text() or "") for p in reader.pages]
            text = "\n\n".join(f"<!-- page {i + 1} -->\n{t.strip()}" for i, t in enumerate(pages))
            md = f"# {doc.get('title') or reader.metadata.title if reader.metadata else doc['url']}\n\nSource: {doc['publisher']}  \nURL: {doc['url']}  \n\n{text}\n"
            (out / "document.md").write_text(md)
            # Garble check: share of "words" that look like real words. Scrambled extraction produces
            # lots of fragments and run-together letters.
            toks = re.findall(r"\S+", text)
            wordlike = sum(1 for t in toks if re.fullmatch(r"[A-Za-z][a-z'\-]{1,20}[.,;:]?", t))
            ratio = round(wordlike / len(toks), 3) if toks else 0.0
            info = reader.metadata or {}
            meta.update({"status": "ok", "pages": len(reader.pages), "words": len(toks),
                         "datesMeta": [{"label": "pdf ModDate", "value": str(info.get("/ModDate", ""))},
                                       {"label": "pdf CreationDate", "value": str(info.get("/CreationDate", ""))}],
                         "check": {"wordlikeRatio": ratio, "flagged": ratio < 0.6 or len(toks) < 50 * max(1, len(reader.pages)) // 10},
                         "visual": "document.pdf",
                         "sha256": {"document.pdf": sha256_bytes(data), "document.md": sha256_bytes(md.encode())}})
        except Exception as e:
            meta.update({"status": "failed", "error": str(e)[:500]})
        out.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(meta, indent=2))
        return meta

    # --- one source: seeds + link following -----------------------------------------------------
    def run_source(self, src: dict, stats: Stats) -> None:
        follow = src.get("follow", {})
        max_depth = follow.get("depth", 0)
        max_pages = follow.get("maxPages", len(src["seeds"]))
        include, exclude = follow.get("include", []), follow.get("exclude", [])
        pdf_rule = src.get("pdfs")
        seen: set[str] = set()
        pdf_links: list[str] = []
        queue = deque(Item(normalize_url(u), 0) for u in src["seeds"])
        done = 0
        while queue and done < max(max_pages, len(src["seeds"])):
            item = queue.popleft()
            if item.url in seen:
                continue
            seen.add(item.url)
            meta = self.capture_page(src, item.url)
            done += 1
            tag = "skip" if meta.get("_skipped") else meta.get("status")
            cov = meta.get("check", {}).get("coverage")
            print(f"[{src['id']}] {done:>3} {tag:<6} d{item.depth} cov={cov} {item.url}", flush=True)
            if meta.get("_skipped"):
                stats.skipped_existing += 1
            elif meta.get("status") == "ok":
                stats.captured += 1
            else:
                stats.failed += 1
                stats.failures.append((item.url, meta.get("error")))
            # Links: from a fresh capture, or re-read from the saved rendered HTML when skipped.
            links = meta.get("_links")
            if links is None and meta.get("status") == "ok":
                rendered = (self.raw / src["id"] / slug_for(item.url) / "page.rendered.html")
                links = re.findall(r'href="([^"#]+)', rendered.read_text(errors="ignore")) if rendered.exists() else []
                links = [urljoin(item.url, l) for l in links]
            for link in links or []:
                if pdf_rule and link.lower().split("?")[0].endswith(".pdf") and matches_any(pdf_rule["include"], link):
                    if link not in pdf_links:
                        pdf_links.append(link)
                if item.depth >= max_depth:
                    continue
                n = normalize_url(link)
                if n in seen or not include or not matches_any(include, n) or matches_any(exclude, n):
                    continue
                queue.append(Item(n, item.depth + 1))
        # Linked PDFs (e.g. hazard info sheets), captured as documents.
        if pdf_rule:
            for link in pdf_links[: pdf_rule.get("max", 10)]:
                doc = {"sourceId": src["id"], "publisher": src["publisher"], "jurisdiction": src["jurisdiction"],
                       "tier": src["tier"], "url": link, "title": Path(urlparse(link).path).stem.replace("_", " ").replace("-", " ")}
                meta = self.capture_pdf(doc, src.get("browser", "headless"))
                print(f"[{src['id']}] pdf {meta.get('status')} {link}", flush=True)
                if meta.get("status") == "ok" and not meta.get("_skipped"):
                    stats.captured += 1
                elif meta.get("status") != "ok":
                    stats.failed += 1
                    stats.failures.append((link, meta.get("error")))


def rebuild_manifest_and_report(corpus: Path, registry: dict) -> None:
    """Re-reads every meta.json and writes manifest.jsonl plus a human-readable COLLECTION-REPORT.md."""
    metas = []
    for mp in sorted((corpus / "raw").glob("*/*/meta.json")):
        m = json.loads(mp.read_text())
        m["folder"] = str(mp.parent.relative_to(corpus))
        metas.append(m)
    with open(corpus / "manifest.jsonl", "w") as f:
        for m in metas:
            f.write(json.dumps({k: v for k, v in m.items() if k != "_links"}) + "\n")

    by_src: dict[str, list] = {}
    for m in metas:
        by_src.setdefault(m["sourceId"], []).append(m)
    lines = ["# Collection report", "",
             f"Generated {now_iso()} by `knowledge/collect.py`. One row per publisher; details per page in `manifest.jsonl` and each folder's `meta.json`.", "",
             "How to check a page by eye: open its folder under `raw/`, then compare `page.pdf` (or `page.png`) with `page.md`.", "",
             "| Source | Publisher | Pages ok | Documents ok | Failed | Flagged for review | Words |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for s in registry["sources"]:
        ms = by_src.get(s["id"], [])
        ok_p = sum(1 for m in ms if m.get("status") == "ok" and m["kind"] == "page")
        ok_d = sum(1 for m in ms if m.get("status") == "ok" and m["kind"] == "document")
        failed = sum(1 for m in ms if m.get("status") != "ok")
        flagged = sum(1 for m in ms if m.get("check", {}).get("flagged"))
        wc = sum(m.get("words", 0) for m in ms if m.get("status") == "ok")
        lines.append(f"| {s['id']} | {s['publisher']} | {ok_p} | {ok_d} | {failed} | {flagged} | {wc:,} |")
    total_words = sum(m.get("words", 0) for m in metas if m.get("status") == "ok")
    lines += ["", f"Total: {sum(1 for m in metas if m.get('status') == 'ok')} items captured, {total_words:,} words.", ""]

    lines += ["## Flagged for review", "",
              "Pages where less than 95% of the visible words reached `page.md`, or PDFs whose text looks garbled.", ""]
    flagged = [m for m in metas if m.get("check", {}).get("flagged")]
    if not flagged:
        lines.append("None.")
    for m in flagged:
        c = m["check"]
        detail = f"coverage {c['coverage']:.2f}, missing e.g. {', '.join(c.get('missingSample', [])[:8])}" if "coverage" in c else f"word-like ratio {c.get('wordlikeRatio')}"
        lines.append(f"- `{m['folder']}`: {detail}")
    lines += ["", "## Failed", ""]
    failed = [m for m in metas if m.get("status") != "ok"]
    if not failed:
        lines.append("None.")
    for m in failed:
        lines.append(f"- {m['url']}: {m.get('error', '')[:160]}")

    lines += ["", "## Freshness", "", "Date printed on the page (or in its metadata) for each item, oldest first. Blank means the page shows no date.", "",
              "| Date shown | Label | Item |", "| --- | --- | --- |"]
    def first_date(m):
        d = (m.get("datesPrinted") or []) + (m.get("datesMeta") or [])
        d = [x for x in d if x.get("value") and x["value"] not in ("", "None")]
        return d[0] if d else {"label": "", "value": ""}
    rows = []
    for m in metas:
        if m.get("status") != "ok":
            continue
        d = first_date(m)
        rows.append((normalize_date(d["value"]) or "", d["label"], m["folder"]))
    for date, label, folder in sorted(rows, key=lambda r: (r[0] == "", r[0])):
        lines.append(f"| {date} | {label} | `{folder}` |")
    (corpus / "COLLECTION-REPORT.md").write_text("\n".join(lines) + "\n")


def normalize_date(value: str) -> str | None:
    """Best-effort conversion of the many date formats sites use to YYYY-MM-DD (None if unknown)."""
    v = (value or "").strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", v)
    if m:
        return m.group(0)
    m = re.search(r"D:(\d{4})(\d{2})(\d{2})", v)  # PDF dates look like D:20200115...
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", v)
    if m:
        y = int(m.group(3))
        y = y + 2000 if y < 100 else y
        return f"{y:04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    for fmt in ("%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y", "%b. %d, %Y"):
        try:
            return datetime.strptime(v.replace("Sept", "Sep"), fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--corpus", default=os.environ.get("CORPUS_DIR"), help="corpus folder (default: $CORPUS_DIR)")
    ap.add_argument("--only", default="", help="comma-separated source ids")
    ap.add_argument("--force", action="store_true", help="recapture items that were already captured")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()
    if not args.corpus:
        sys.exit("Set CORPUS_DIR (e.g. in .env) or pass --corpus.")
    corpus = Path(args.corpus).expanduser()
    registry = json.loads((HERE / "sources.json").read_text())
    if args.report_only:
        rebuild_manifest_and_report(corpus, registry)
        return 0

    only = {s for s in args.only.split(",") if s}
    col = Collector(corpus, args.force)
    stats = Stats()
    try:
        for src in registry["sources"]:
            if only and src["id"] not in only:
                continue
            col.run_source(src, stats)
        for doc in registry.get("documents", []):
            if only and doc["sourceId"] not in only:
                continue
            meta = col.capture_pdf(doc, "headless")
            print(f"[doc] {meta.get('status')} {doc['url']}", flush=True)
    finally:
        col.close()
        rebuild_manifest_and_report(corpus, registry)
    print(f"done: captured {stats.captured}, already had {stats.skipped_existing}, failed {stats.failed}")
    for u, e in stats.failures[:30]:
        print("  FAIL", u, (e or "")[:120])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
