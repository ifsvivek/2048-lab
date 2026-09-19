package dev.g2048.engine;

/** Replay simulation and verification (SPEC §8). */
public final class Replay {
  private Replay() {}

  public static final String INVALID_MOVE_AT = "INVALID_MOVE_AT";
  public static final String BAD_LETTER = "BAD_LETTER";
  public static final String SPEC_VERSION = "SPEC_VERSION";
  public static final String FINAL_MISMATCH = "FINAL_MISMATCH";

  /** Replay verification failure; moveIndex is -1 when not applicable. */
  public static final class ReplayException extends Exception {
    public final String code;
    public final int moveIndex;

    public ReplayException(String code, String message, int moveIndex) {
      super(message);
      this.code = code;
      this.moveIndex = moveIndex;
    }
  }

  /** Client-claimed final values; null fields are not checked. */
  public record FinalClaim(String board, Long score, Integer moveCount, String historyHash) {}

  public static int letterToDirection(char ch, int at) throws ReplayException {
    int d = Board.DIRECTION_LETTERS.indexOf(ch);
    if (d < 0) throw new ReplayException(BAD_LETTER, "bad move letter '" + ch + "' at " + at, at);
    return d;
  }

  public static Game simulate(int seed, String moves) throws ReplayException {
    Game g = new Game(seed);
    for (int i = 0; i < moves.length(); i++) {
      int d = letterToDirection(moves.charAt(i), i);
      if (g.apply(d) < 0) throw new ReplayException(INVALID_MOVE_AT, "INVALID_MOVE_AT " + i, i);
    }
    return g;
  }

  public static Game.Snapshot verify(int specVersion, int seed, String moves, FinalClaim fin) throws ReplayException {
    if (specVersion != Game.SPEC_VERSION)
      throw new ReplayException(SPEC_VERSION, "unsupported specVersion " + specVersion, -1);
    Game.Snapshot snap = simulate(seed, moves).snapshot();
    if (fin != null) {
      if (fin.board() != null && !fin.board().equals(snap.board())) throw mismatch("board", fin.board(), snap.board());
      if (fin.score() != null && fin.score() != snap.score()) throw mismatch("score", fin.score(), snap.score());
      if (fin.moveCount() != null && fin.moveCount() != snap.moveCount())
        throw mismatch("moveCount", fin.moveCount(), snap.moveCount());
      if (fin.historyHash() != null && !fin.historyHash().equals(snap.historyHash()))
        throw mismatch("historyHash", fin.historyHash(), snap.historyHash());
    }
    return snap;
  }

  private static ReplayException mismatch(String key, Object claimed, Object actual) {
    return new ReplayException(FINAL_MISMATCH, "final." + key + " mismatch: claimed " + claimed + ", actual " + actual, -1);
  }
}
