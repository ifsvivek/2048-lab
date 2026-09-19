/**
 * Structured JSON logs. Workers Logs (observability.enabled) indexes these
 * fields, so every line is one JSON object with a stable `event` name.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
