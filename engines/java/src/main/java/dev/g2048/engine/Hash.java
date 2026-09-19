package dev.g2048.engine;

/** FNV-1a state hashes (SPEC §7). */
public final class Hash {
  private Hash() {}

  private static final int OFFSET = 0x811C9DC5;
  private static final int PRIME = 0x01000193;

  public static int fnv1a32(byte[] data) {
    int h = OFFSET;
    for (byte c : data) h = (h ^ (c & 0xff)) * PRIME;
    return h;
  }

  public static int boardHash(byte[] b) {
    int h = OFFSET;
    for (int i = 0; i < 16; i++) h = (h ^ (b[i] & 0xff)) * PRIME;
    return h;
  }

  /** fnv1a32(le32(h) ++ board ++ [dir]). */
  public static int historyStep(int h, byte[] b, int dir) {
    int x = OFFSET;
    for (int k = 0; k < 4; k++) x = (x ^ ((h >>> (8 * k)) & 0xff)) * PRIME;
    for (int i = 0; i < 16; i++) x = (x ^ (b[i] & 0xff)) * PRIME;
    return (x ^ dir) * PRIME;
  }

  /** 8 lowercase hex digits. */
  public static String hex(int h) {
    String s = Integer.toHexString(h);
    return "00000000".substring(s.length()) + s;
  }
}
