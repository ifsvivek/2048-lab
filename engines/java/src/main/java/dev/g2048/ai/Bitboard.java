package dev.g2048.ai;

import dev.g2048.engine.Board;

/** 64-bit bitboard: cell i occupies bits 4i..4i+3 (AI.md §1). Moves saturate at rank 15. */
public final class Bitboard {
  private Bitboard() {}

  /** Slides toward the low nibble ("left" for rows, "up" for columns). Unsigned 16-bit values. */
  static final char[] TOWARD_LOW = new char[65536];
  /** Slides toward the high nibble ("right" / "down"). */
  static final char[] TOWARD_HIGH = new char[65536];
  /** Places a line value as column 0 (nibble k -> row k). */
  static final long[] SPREAD_COL = new long[65536];

  private static int reverseLine(int v) {
    return (v & 0xf) << 12 | ((v >>> 4) & 0xf) << 8 | ((v >>> 8) & 0xf) << 4 | (v >>> 12) & 0xf;
  }

  static {
    int[] r = new int[4];
    int[] tiles = new int[4];
    int[] out = new int[4];
    for (int v = 0; v < 65536; v++) {
      for (int k = 0; k < 4; k++) r[k] = (v >>> (4 * k)) & 0xf;
      int n = 0;
      for (int x : r) if (x != 0) tiles[n++] = x;
      java.util.Arrays.fill(out, 0);
      int o = 0;
      for (int i = 0; i < n; i++) {
        if (i + 1 < n && tiles[i] == tiles[i + 1]) {
          out[o] = Math.min(tiles[i] + 1, 15);
          i++;
        } else {
          out[o] = tiles[i];
        }
        o++;
      }
      TOWARD_LOW[v] = (char) (out[0] | out[1] << 4 | out[2] << 8 | out[3] << 12);
      SPREAD_COL[v] = (long) r[0] | (long) r[1] << 16 | (long) r[2] << 32 | (long) r[3] << 48;
    }
    for (int v = 0; v < 65536; v++) TOWARD_HIGH[v] = (char) reverseLine(TOWARD_LOW[reverseLine(v)]);
  }

  /** Column c as a line value (row 0 in the lowest nibble). */
  public static int column(long b, int c) {
    long x = b >>> (4 * c);
    return (int) ((x & 0xf) | ((x >>> 16) & 0xf) << 4 | ((x >>> 32) & 0xf) << 8 | ((x >>> 48) & 0xf) << 12);
  }

  /** Applies dir (saturating at rank 15); the result equals b iff the move is invalid. */
  public static long move(long b, int dir) {
    return switch (dir) {
      case Board.LEFT -> rows(b, TOWARD_LOW);
      case Board.RIGHT -> rows(b, TOWARD_HIGH);
      case Board.UP -> cols(b, TOWARD_LOW);
      default -> cols(b, TOWARD_HIGH);
    };
  }

  private static long rows(long b, char[] t) {
    return (long) t[(int) (b & 0xffff)]
        | (long) t[(int) ((b >>> 16) & 0xffff)] << 16
        | (long) t[(int) ((b >>> 32) & 0xffff)] << 32
        | (long) t[(int) (b >>> 48)] << 48;
  }

  private static long cols(long b, char[] t) {
    return transpose(rows(transpose(b), t));
  }

  /** Transposes the 4x4 nibble matrix (row r of the result = column r of b). */
  public static long transpose(long x) {
    long a1 = x & 0xF0F00F0FF0F00F0FL;
    long a2 = x & 0x0000F0F00000F0F0L;
    long a3 = x & 0x0F0F00000F0F0000L;
    long a = a1 | (a2 << 12) | (a3 >>> 12);
    long b1 = a & 0xFF00FF0000FF00FFL;
    long b2 = a & 0x00FF00FF00000000L;
    long b3 = a & 0x00000000FF00FF00L;
    return b1 | (b2 >>> 24) | (b3 << 24);
  }

  /** One bit (the nibble's lowest) set per empty cell. */
  public static long emptyMask(long b) {
    long occ = (b | b >>> 1 | b >>> 2 | b >>> 3) & 0x1111111111111111L;
    return ~occ & 0x1111111111111111L;
  }

  /** Converts a game board, clamping exponents above 15. */
  public static long fromBoard(byte[] board) {
    long b = 0;
    for (int i = 0; i < 16; i++) b |= (long) Math.min(board[i], 15) << (4 * i);
    return b;
  }

  public static byte[] toBoard(long b) {
    byte[] out = new byte[16];
    for (int i = 0; i < 16; i++) out[i] = (byte) ((b >>> (4 * i)) & 0xf);
    return out;
  }

  /** Number of distinct non-zero ranks. */
  public static int distinctRanks(long b) {
    int mask = 0;
    for (int i = 0; i < 16; i++) mask |= 1 << ((b >>> (4 * i)) & 0xf);
    return Integer.bitCount(mask & ~1);
  }

  public static int countEmpty(long b) {
    return Long.bitCount(emptyMask(b));
  }
}
