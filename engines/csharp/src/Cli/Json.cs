using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace G2048.Cli;

/// <summary>Ordered JSON object for output (keys serialised in insertion order).</summary>
public sealed class JObj : IEnumerable<KeyValuePair<string, object?>>
{
    private readonly List<KeyValuePair<string, object?>> _items = [];

    public void Add(string key, object? value) => _items.Add(new(key, value));

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => _items.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>
/// Minimal JSON writer mimicking Go's encoding/json: MarshalIndent-style
/// layout, HTML-safe string escaping and Go's float formatting.
/// </summary>
public static class Json
{
    public static string Serialize(object? value, bool indent)
    {
        var sb = new StringBuilder();
        Write(sb, value, indent ? 0 : -1);
        return sb.ToString();
    }

    private static void Newline(StringBuilder sb, int level)
    {
        if (level < 0) return;
        sb.Append('\n');
        sb.Append(' ', level * 2);
    }

    private static void Write(StringBuilder sb, object? v, int level)
    {
        int inner = level < 0 ? -1 : level + 1;
        switch (v)
        {
            case null:
                sb.Append("null");
                break;
            case string s:
                WriteString(sb, s);
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case int or long or uint or ulong or short or ushort or byte or sbyte:
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                break;
            case double d:
                sb.Append(FormatFloat(d));
                break;
            case float f:
                sb.Append(FormatFloat(f));
                break;
            case JsonNode node:
                WriteNode(sb, node, level);
                break;
            case JObj obj:
            {
                bool first = true;
                sb.Append('{');
                foreach (var (k, val) in obj)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Newline(sb, inner);
                    WriteString(sb, k);
                    sb.Append(level < 0 ? ":" : ": ");
                    Write(sb, val, inner);
                }
                if (!first) Newline(sb, level);
                sb.Append('}');
                break;
            }
            case IEnumerable seq:
            {
                bool first = true;
                sb.Append('[');
                foreach (var item in seq)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Newline(sb, inner);
                    Write(sb, item, inner);
                }
                if (!first) Newline(sb, level);
                sb.Append(']');
                break;
            }
            default:
                throw new ArgumentException($"cannot serialise {v.GetType()}");
        }
    }

    private static void WriteNode(StringBuilder sb, JsonNode node, int level)
    {
        switch (node)
        {
            case JsonObject o:
            {
                var obj = new JObj();
                foreach (var (k, val) in o) obj.Add(k, val);
                Write(sb, obj, level);
                break;
            }
            case JsonArray a:
            {
                var list = new List<object?>();
                foreach (var item in a) list.Add(item);
                Write(sb, list, level);
                break;
            }
            case JsonValue jv:
                switch (jv.GetValueKind())
                {
                    case JsonValueKind.String: WriteString(sb, jv.GetValue<string>()); break;
                    case JsonValueKind.Number: sb.Append(jv.ToJsonString()); break;
                    case JsonValueKind.True: sb.Append("true"); break;
                    case JsonValueKind.False: sb.Append("false"); break;
                    default: sb.Append("null"); break;
                }
                break;
        }
    }

    public static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '<' or '>' or '&' or (char)0x2028 or (char)0x2029:
                    sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>
    /// Formats a float64 like Go's encoding/json: shortest round-trip digits,
    /// plain notation for 1e-6 &lt;= |x| &lt; 1e21, otherwise exponent form (1e+21).
    /// </summary>
    public static string FormatFloat(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        if (d == 0) return "0";
        string r = d.ToString("R", CultureInfo.InvariantCulture);
        double abs = Math.Abs(d);
        int e = r.IndexOfAny(['E', 'e']);
        if (abs < 1e-6 || abs >= 1e21)
        {
            // Go: mantissa + "e" + sign + at least two exponent digits
            // ("R" always uses exponent form in this range)
            string mant = r[..e];
            int exp = int.Parse(r[(e + 1)..], CultureInfo.InvariantCulture);
            return $"{mant}e{(exp < 0 ? "-" : "+")}{Math.Abs(exp):00}";
        }
        if (e < 0) return r;
        // expand exponent form into plain notation
        bool neg = r[0] == '-';
        string m = r[(neg ? 1 : 0)..e];
        int x = int.Parse(r[(e + 1)..], CultureInfo.InvariantCulture);
        int dot = m.IndexOf('.');
        string digits = dot < 0 ? m : m.Remove(dot, 1);
        int pointPos = (dot < 0 ? m.Length : dot) + x;
        string res;
        if (pointPos <= 0) res = "0." + new string('0', -pointPos) + digits;
        else if (pointPos >= digits.Length) res = digits + new string('0', pointPos - digits.Length);
        else res = digits[..pointPos] + "." + digits[pointPos..];
        return neg ? "-" + res : res;
    }
}
