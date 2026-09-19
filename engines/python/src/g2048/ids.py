"""SPEC §9 — seeds, game IDs (ULID) and human-friendly replay codes."""

from __future__ import annotations

import re
import secrets
import time

REPLAY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_STRIP_RE = re.compile(r"[^A-Z0-9]")


def random_seed() -> int:
    return secrets.randbits(32)


def ulid(now_ms: int | None = None) -> str:
    """48-bit millisecond timestamp + 80 random bits, Crockford base32."""
    t = int(time.time() * 1000) if now_ms is None else int(now_ms)
    chars = []
    for _ in range(10):
        chars.append(CROCKFORD[t % 32])
        t //= 32
    time_part = "".join(reversed(chars))
    rnd = secrets.token_bytes(16)
    return time_part + "".join(CROCKFORD[b & 31] for b in rnd)


def is_ulid(s: str) -> bool:
    return bool(_ULID_RE.match(s))


def normalize_replay_code(value: str) -> str | None:
    """Upper-case and strip everything outside [A-Z0-9]; None if not a valid code."""
    s = _STRIP_RE.sub("", value.upper())
    if len(s) != 12:
        return None
    for ch in s:
        if ch not in REPLAY_ALPHABET:
            return None
    return s


def format_replay_code(normalized: str) -> str:
    return f"{normalized[0:4]}-{normalized[4:8]}-{normalized[8:12]}"


def generate_replay_code() -> str:
    rnd = secrets.token_bytes(12)
    return format_replay_code("".join(REPLAY_ALPHABET[b & 31] for b in rnd))
