package dev.g2048.bench;

import dev.g2048.json.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Benchmark suite definition (spec/benchmarks/*.json). */
public record Suite(
    String id, String name, String description, int specVersion, String agentId, Map<String, Object> agentConfig,
    long seedStart, int seedCount, int maxMoves, boolean timeDecisions, List<String> tags) {

  public boolean hasTag(String t) {
    return tags.contains(t);
  }

  public static Suite load(Path path) throws IOException {
    Map<String, Object> m;
    try {
      m = Json.obj(Json.parse(Files.readString(path)));
    } catch (IllegalArgumentException e) {
      throw new IOException(path + ": " + e.getMessage(), e);
    }
    Map<String, Object> agent = Json.obj(m.get("agent"));
    Map<String, Object> seeds = Json.obj(m.get("seeds"));
    Object cfg = agent.get("config");
    List<String> tags = new ArrayList<>();
    if (m.get("tags") instanceof List<?> l) for (Object o : l) tags.add(Json.str(o));
    return new Suite(
        Json.str(m.get("id")),
        m.get("name") instanceof String s ? s : "",
        m.get("description") instanceof String s ? s : "",
        (int) Json.lng(m.get("specVersion")),
        Json.str(agent.get("id")),
        cfg == null ? null : Json.obj(cfg),
        Json.lng(seeds.get("start")),
        (int) Json.lng(seeds.get("count")),
        m.get("maxMoves") == null ? 0 : (int) Json.lng(m.get("maxMoves")),
        m.get("timeDecisions") instanceof Boolean b && b,
        tags);
  }
}
