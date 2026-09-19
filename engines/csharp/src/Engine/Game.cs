using System.Text;

namespace G2048.Engine;

/// <summary>Serialisable game state.</summary>
public sealed record Snapshot(uint Seed, string Board, long Score, int MoveCount, long MaxTile, bool Over, string HistoryHash);

/// <summary>The SPEC §6 game lifecycle.</summary>
public sealed class Game
{
    public const int SpecVersion = 1;
    public const string EngineVersion = "1.0.0";

    public uint Seed { get; }
    public byte[] Board { get; } = new byte[16];
    public long Score { get; private set; }
    public int MoveCount { get; private set; }
    public Rng Rng { get; }
    public uint Hash { get; private set; }

    private readonly StringBuilder _moves = new();

    public Game(uint seed)
    {
        Seed = seed;
        Rng = Rng.FromSeed(seed);
        Engine.Board.Spawn(Board, Rng);
        Engine.Board.Spawn(Board, Rng);
        Hash = Engine.Hash.BoardHash(Board);
    }

    /// <summary>Applies a move; returns false (no state change) if it is invalid.</summary>
    public bool Apply(int dir, out long gained)
    {
        gained = Engine.Board.MoveInPlace(Board, dir);
        if (gained < 0)
        {
            gained = 0;
            return false;
        }
        Score += gained;
        MoveCount++;
        Engine.Board.Spawn(Board, Rng);
        Hash = Engine.Hash.HistoryStep(Hash, Board, dir);
        _moves.Append(Engine.Board.DirectionLetters[dir]);
        return true;
    }

    public bool Apply(int dir) => Apply(dir, out _);

    public bool Over => Engine.Board.IsOver(Board);

    public string HistoryHash => Engine.Hash.Hex(Hash);

    public string Moves => _moves.ToString();

    public Snapshot Snapshot() =>
        new(Seed, Engine.Board.Hex(Board), Score, MoveCount, Engine.Board.MaxTile(Board), Over, HistoryHash);
}
