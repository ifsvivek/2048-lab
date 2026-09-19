package dev.g2048.engine;

/** The SPEC §6 game lifecycle. */
public final class Game {
  public static final int SPEC_VERSION = 1;
  public static final String ENGINE_VERSION = "1.0.0";

  /** Serialisable game state. */
  public record Snapshot(long seed, String board, long score, int moveCount, long maxTile, boolean over, String historyHash) {
    public java.util.Map<String, Object> toMap() {
      var m = new java.util.LinkedHashMap<String, Object>();
      m.put("seed", seed);
      m.put("board", board);
      m.put("score", score);
      m.put("moveCount", moveCount);
      m.put("maxTile", maxTile);
      m.put("over", over);
      m.put("historyHash", historyHash);
      return m;
    }
  }

  public final int seed;
  public final byte[] board = new byte[16];
  public long score;
  public int moveCount;
  public final Rng rng;
  public int hash;
  private final StringBuilder moves = new StringBuilder();

  public Game(int seed) {
    this.seed = seed;
    this.rng = Rng.fromSeed(seed);
    Board.spawnPacked(board, rng);
    Board.spawnPacked(board, rng);
    hash = Hash.boardHash(board);
  }

  /** Applies a move; returns the score gained, or -1 if invalid (no state change). */
  public long apply(int dir) {
    long gained = Board.moveInPlace(board, dir);
    if (gained < 0) return -1;
    score += gained;
    moveCount++;
    Board.spawnPacked(board, rng);
    hash = Hash.historyStep(hash, board, dir);
    moves.append(Board.DIRECTION_LETTERS.charAt(dir));
    return gained;
  }

  public boolean over() {
    return Board.isOver(board);
  }

  public String historyHash() {
    return Hash.hex(hash);
  }

  public String moves() {
    return moves.toString();
  }

  public long seedUnsigned() {
    return Integer.toUnsignedLong(seed);
  }

  public Snapshot snapshot() {
    return new Snapshot(seedUnsigned(), Board.hex(board), score, moveCount, Board.maxTile(board), over(), historyHash());
  }
}
