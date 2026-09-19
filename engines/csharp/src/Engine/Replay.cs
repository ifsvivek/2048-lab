using System;

namespace G2048.Engine;

/// <summary>Replay verification failure (SPEC §8). MoveIndex is -1 when not applicable.</summary>
public sealed class ReplayException(string code, string message, int moveIndex) : Exception(message)
{
    public const string InvalidMoveAt = "INVALID_MOVE_AT";
    public const string BadLetter = "BAD_LETTER";
    public const string SpecVersionError = "SPEC_VERSION";
    public const string FinalMismatch = "FINAL_MISMATCH";

    public string Code { get; } = code;
    public int MoveIndex { get; } = moveIndex;
}

/// <summary>Client-claimed final values; null fields are not checked.</summary>
public sealed record FinalClaim(string? Board = null, long? Score = null, int? MoveCount = null, string? HistoryHash = null);

public static class Replay
{
    public static int LetterToDirection(char ch, int at)
    {
        int d = Board.DirectionLetters.IndexOf(ch);
        if (d < 0) throw new ReplayException(ReplayException.BadLetter, $"bad move letter '{ch}' at {at}", at);
        return d;
    }

    /// <summary>Re-plays moves from seed.</summary>
    public static Game Simulate(uint seed, string moves)
    {
        var g = new Game(seed);
        for (int i = 0; i < moves.Length; i++)
        {
            int d = LetterToDirection(moves[i], i);
            if (!g.Apply(d)) throw new ReplayException(ReplayException.InvalidMoveAt, $"INVALID_MOVE_AT {i}", i);
        }
        return g;
    }

    /// <summary>Re-simulates a replay and returns the authoritative snapshot.</summary>
    public static Snapshot Verify(int specVersion, uint seed, string moves, FinalClaim? final)
    {
        if (specVersion != Game.SpecVersion)
            throw new ReplayException(ReplayException.SpecVersionError, $"unsupported specVersion {specVersion}", -1);
        var snap = Simulate(seed, moves).Snapshot();
        if (final is null) return snap;
        static ReplayException Mismatch(string key, object claimed, object actual) =>
            new(ReplayException.FinalMismatch, $"final.{key} mismatch: claimed {claimed}, actual {actual}", -1);
        if (final.Board is not null && final.Board != snap.Board) throw Mismatch("board", final.Board, snap.Board);
        if (final.Score is long s && s != snap.Score) throw Mismatch("score", s, snap.Score);
        if (final.MoveCount is int m && m != snap.MoveCount) throw Mismatch("moveCount", m, snap.MoveCount);
        if (final.HistoryHash is not null && final.HistoryHash != snap.HistoryHash)
            throw Mismatch("historyHash", final.HistoryHash, snap.HistoryHash);
        return snap;
    }
}
