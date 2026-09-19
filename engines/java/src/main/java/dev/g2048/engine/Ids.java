package dev.g2048.engine;

import java.security.SecureRandom;
import java.util.regex.Pattern;

/** Seeds, ULIDs and replay codes (SPEC §9). */
public final class Ids {
  private Ids() {}

  public static final String REPLAY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  private static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  private static final SecureRandom RNG = new SecureRandom();
  private static final Pattern ULID_RE = Pattern.compile("^[0-9A-HJKMNP-TV-Z]{26}$");

  private static byte[] randomBytes(int n) {
    byte[] b = new byte[n];
    RNG.nextBytes(b);
    return b;
  }

  /** A uint32 seed (as a Java int) from a CSPRNG. */
  public static int randomSeed() {
    return RNG.nextInt();
  }

  public static String ulid(long unixMillis) {
    char[] out = new char[26];
    long t = unixMillis;
    for (int i = 9; i >= 0; i--) {
      out[i] = CROCKFORD.charAt((int) (t % 32));
      t /= 32;
    }
    byte[] rnd = randomBytes(16);
    for (int i = 0; i < 16; i++) out[10 + i] = CROCKFORD.charAt(rnd[i] & 31);
    return new String(out);
  }

  public static String ulid() {
    return ulid(System.currentTimeMillis());
  }

  public static boolean isUlid(String s) {
    return ULID_RE.matcher(s).matches();
  }

  public static String generateReplayCode() {
    byte[] rnd = randomBytes(12);
    char[] s = new char[12];
    for (int i = 0; i < 12; i++) s[i] = REPLAY_ALPHABET.charAt(rnd[i] & 31);
    return formatReplayCode(new String(s));
  }

  /** Upper-cases, strips non [A-Z0-9], validates; returns null if invalid. */
  public static String normalizeReplayCode(String input) {
    StringBuilder sb = new StringBuilder();
    for (char c : input.toUpperCase().toCharArray()) {
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.append(c);
    }
    String s = sb.toString();
    if (s.length() != 12) return null;
    for (int i = 0; i < 12; i++) if (REPLAY_ALPHABET.indexOf(s.charAt(i)) < 0) return null;
    return s;
  }

  public static String formatReplayCode(String n) {
    return n.substring(0, 4) + "-" + n.substring(4, 8) + "-" + n.substring(8, 12);
  }
}
