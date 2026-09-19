package dev.g2048.engine;

/**
 * Board helpers over {@code byte[16]} exponent arrays, row-major (SPEC §1–§5).
 */
public final class Board {
  private Board() {}

  public static final int UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
  public static final String DIRECTION_LETTERS = "UDLR";
  public static final String[] DIRECTION_NAMES = {"up", "down", "left", "right"};
  private static final String HEX_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

  /** LINES[dir][line][k] = cell index, starting at the edge tiles slide toward (SPEC §3). */
  public static final int[][][] LINES = new int[4][4][4];

  static {
    for (int k = 0; k < 4; k++) {
      for (int j = 0; j < 4; j++) {
        LINES[UP][k][j] = j * 4 + k;
        LINES[DOWN][k][j] = (3 - j) * 4 + k;
        LINES[LEFT][k][j] = k * 4 + j;
        LINES[RIGHT][k][j] = k * 4 + 3 - j;
      }
    }
  }

  public static String hex(byte[] b) {
    char[] s = new char[16];
    for (int i = 0; i < 16; i++) s[i] = HEX_DIGITS.charAt(b[i]);
    return new String(s);
  }

  public static byte[] fromHex(String hex) {
    if (hex.length() != 16) throw new IllegalArgumentException("boardHex must be 16 chars, got " + hex.length());
    byte[] b = new byte[16];
    for (int i = 0; i < 16; i++) {
      int v = HEX_DIGITS.indexOf(Character.toLowerCase(hex.charAt(i)));
      if (v < 0) throw new IllegalArgumentException("invalid boardHex character '" + hex.charAt(i) + "'");
      b[i] = (byte) v;
    }
    return b;
  }

  public static int maxExponent(byte[] b) {
    int m = 0;
    for (byte e : b) if (e > m) m = e;
    return m;
  }

  /** Largest tile value (0 for an empty board). */
  public static long maxTile(byte[] b) {
    int e = maxExponent(b);
    return e == 0 ? 0 : 1L << e;
  }

  /** Applies dir in place. Returns the score gained, or -1 if invalid (board untouched). */
  public static long moveInPlace(byte[] b, int dir) {
    long gained = 0;
    boolean changed = false;
    int[][] lines = LINES[dir];
    byte[] tiles = new byte[4];
    byte[] res = new byte[4];
    for (int l = 0; l < 4; l++) {
      int[] idx = lines[l];
      int n = 0;
      for (int k = 0; k < 4; k++) {
        byte v = b[idx[k]];
        if (v != 0) tiles[n++] = v;
      }
      int out = 0;
      for (int i = 0; i < n; ) {
        if (i + 1 < n && tiles[i] == tiles[i + 1]) {
          int e = tiles[i] + 1;
          res[out] = (byte) e;
          gained += 1L << e;
          i += 2;
        } else {
          res[out] = tiles[i];
          i++;
        }
        out++;
      }
      for (; out < 4; out++) res[out] = 0;
      for (int k = 0; k < 4; k++) {
        if (b[idx[k]] != res[k]) {
          b[idx[k]] = res[k];
          changed = true;
        }
      }
    }
    return changed ? gained : -1;
  }

  /** Result of a non-mutating move. */
  public record MoveResult(byte[] board, long gained, boolean changed) {}

  public static MoveResult move(byte[] b, int dir) {
    byte[] nb = b.clone();
    long g = moveInPlace(nb, dir);
    if (g < 0) return new MoveResult(b.clone(), 0, false);
    return new MoveResult(nb, g, true);
  }

  public static boolean canMove(byte[] b, int dir) {
    int[][] lines = LINES[dir];
    for (int l = 0; l < 4; l++) {
      int[] idx = lines[l];
      for (int k = 1; k < 4; k++) {
        byte prev = b[idx[k - 1]], cur = b[idx[k]];
        if (cur != 0 && (prev == 0 || prev == cur)) return true;
      }
    }
    return false;
  }

  public static int[] validMoves(byte[] b) {
    int[] tmp = new int[4];
    int n = 0;
    for (int d = 0; d < 4; d++) if (canMove(b, d)) tmp[n++] = d;
    return java.util.Arrays.copyOf(tmp, n);
  }

  public static boolean isOver(byte[] b) {
    for (int d = 0; d < 4; d++) if (canMove(b, d)) return false;
    return true;
  }

  /** Spawn result; index -1 means the board was full (no draws). */
  public record Spawned(int index, int exponent) {
    public boolean ok() {
      return index >= 0;
    }
  }

  /** Places a tile per SPEC §5. Returns packed (index << 8 | exponent), or -1 if full. */
  public static int spawnPacked(byte[] b, Rng r) {
    int[] empties = new int[16];
    int n = 0;
    for (int i = 0; i < 16; i++) if (b[i] == 0) empties[n++] = i;
    if (n == 0) return -1;
    int index = empties[(int) r.below(n)];
    int exponent = r.below(10) == 0 ? 2 : 1;
    b[index] = (byte) exponent;
    return index << 8 | exponent;
  }

  public static Spawned spawn(byte[] b, Rng r) {
    int p = spawnPacked(b, r);
    return p < 0 ? new Spawned(-1, 0) : new Spawned(p >>> 8, p & 0xff);
  }

  /** Accepts names ("left"), letters ("L") or digits ("2"). */
  public static int parseDirection(String s) {
    String t = s.trim().toLowerCase();
    for (int i = 0; i < 4; i++) if (t.equals(DIRECTION_NAMES[i])) return i;
    if (t.length() == 1) {
      int i = "udlr".indexOf(t.charAt(0));
      if (i >= 0) return i;
      char c = t.charAt(0);
      if (c >= '0' && c <= '3') return c - '0';
    }
    throw new IllegalArgumentException("invalid direction '" + s + "'");
  }
}
