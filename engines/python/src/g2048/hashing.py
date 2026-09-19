"""SPEC §7 — FNV-1a 32-bit board and history hashes."""

from __future__ import annotations

FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193
M32 = 0xFFFFFFFF


def fnv1a32(data, h: int = FNV_OFFSET) -> int:
    """FNV-1a over an iterable of byte values (or a bytes object)."""
    for b in data:
        h = ((h ^ (b & 0xFF)) * FNV_PRIME) & M32
    return h


def board_hash(board) -> int:
    return fnv1a32(board)


def history_step(h: int, board, direction: int) -> int:
    """h' = fnv1a32(le32(h) ++ board ++ [dir])."""
    x = FNV_OFFSET
    x = ((x ^ (h & 0xFF)) * FNV_PRIME) & M32
    x = ((x ^ ((h >> 8) & 0xFF)) * FNV_PRIME) & M32
    x = ((x ^ ((h >> 16) & 0xFF)) * FNV_PRIME) & M32
    x = ((x ^ (h >> 24)) * FNV_PRIME) & M32
    for b in board:
        x = ((x ^ b) * FNV_PRIME) & M32
    return ((x ^ direction) * FNV_PRIME) & M32


def hash_hex(h: int) -> str:
    return format(h & M32, "08x")
