"""
pack_config.py: one place that configures Cognee for this project, for both building and serving.

WHERE THIS FITS
  Imported first by build_pack.py (online, build time) and serve.py (offline, every question).
  Cognee reads its settings from environment variables when it is imported, so configure() MUST run
  before `import cognee`.

THE RULES IT ENCODES (and why)
  - The pack is static. Cognee's self-improvement, feedback learning, chat-session memory and
    automatic "improve after remember" are switched off: the app only reads the pack.
  - Embeddings are always the same small local model (BAAI/bge-small-en-v1.5 via fastembed, CPU).
    The library is embedded with it at build time and questions are embedded with it offline, so it
    must be identical in both places and must not need the internet.
  - The LLM is only used at BUILD time (graph extraction, conflict review). It is a frontier model
    reached through an OpenAI-compatible endpoint (BUILD_LLM_* variables in .env). At serve time no
    LLM is configured on purpose: search must work with the network unplugged.
  - Telemetry and multi-user access control are off: single local user, nothing leaves the machine.

USAGE
  from pack_config import configure
  configure(pack_dir, mode="build")   # or mode="serve"
  import cognee
"""
from __future__ import annotations

import json
import os
from pathlib import Path

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMENSIONS = 384
DATASET = "library"


def configure(pack_dir: Path, mode: str) -> None:
    """Set Cognee's environment for this project.
    pack_dir: folder holding the pack's databases (created if missing).
    mode: 'build' (frontier LLM allowed) or 'serve' (no LLM at all)."""
    pack_dir = Path(pack_dir).expanduser().resolve()
    pack_dir.mkdir(parents=True, exist_ok=True)
    env = {
        # Where the databases (SQLite, LanceDB vectors, Ladybug graph) and stored copies live.
        "SYSTEM_ROOT_DIRECTORY": str(pack_dir / "system"),
        "DATA_ROOT_DIRECTORY": str(pack_dir / "data"),
        "CACHE_ROOT_DIRECTORY": str(pack_dir / "cache"),
        # Local embeddings, identical at build and serve time.
        "EMBEDDING_PROVIDER": "fastembed",
        "EMBEDDING_MODEL": EMBEDDING_MODEL,
        "EMBEDDING_DIMENSIONS": str(EMBEDDING_DIMENSIONS),
        # Static pack: no learning, no session memory, no feedback loop.
        "CACHING": "false",
        "AUTO_FEEDBACK": "false",
        "IMPROVE_AUTO_ENABLED": "false",
        "PERSONALIZATION_ENABLED": "false",
        # Graph database (Ladybug, a Kuzu fork) limits. Cognee's defaults reserve a 32 GB buffer pool and a
        # 32 GB address range for the database. A full library build hit "Maximum database size reached"
        # (pages written between checkpoints count, not the file size, which stayed under 1 GB). So: a much
        # larger address range (virtual, costs nothing) and a buffer pool that fits a 24 GB laptop.
        # Both must be powers of two.
        "KUZU_MAX_DB_SIZE": str(1 << 40),
        "KUZU_BUFFER_POOL_SIZE": str(1 << 32),
        # Keep the "which chunk supports this graph edge" evidence: needed for conflict review.
        "EDGE_EVIDENCE_ENABLED": "true",
        # Local single user; nothing sent anywhere.
        "TELEMETRY_DISABLED": "1",
        "ENABLE_BACKEND_ACCESS_CONTROL": "false",
        "REQUIRE_AUTHENTICATION": "false",
        "ALLOW_HTTP_REQUESTS": "false",
        "LOG_LEVEL": os.environ.get("LOG_LEVEL", "WARNING"),
    }
    if mode == "build":
        base = os.environ.get("BUILD_LLM_BASE_URL")
        key = os.environ.get("BUILD_LLM_API_KEY")
        model = os.environ.get("BUILD_LLM_MODEL", "gpt-6.1-sol")
        effort = os.environ.get("BUILD_LLM_REASONING_EFFORT", "")
        if not (base and key):
            raise SystemExit("BUILD_LLM_BASE_URL and BUILD_LLM_API_KEY must be set (see .env.example).")
        env.update({
            "LLM_PROVIDER": "openai",           # the endpoint speaks the OpenAI API
            "LLM_MODEL": f"openai/{model}",     # 'openai/' prefix tells LiteLLM which protocol to use
            "LLM_ENDPOINT": base,
            "LLM_API_KEY": key,
            "LLM_ARGS": json.dumps({"reasoning_effort": effort} if effort else {}),
            "LLM_MAX_COMPLETION_TOKENS": "32000",
        })
    elif mode == "serve":
        # Deliberately no LLM. Any code path that tries to call one fails fast instead of reaching out.
        env.update({"LLM_PROVIDER": "openai", "LLM_MODEL": "openai/none", "LLM_ENDPOINT": "http://127.0.0.1:9/v1",
                    "LLM_API_KEY": "offline", "COGNEE_SKIP_CONNECTION_TEST": "true"})
    else:
        raise ValueError(f"unknown mode {mode!r}")
    os.environ.update(env)
