/** API origin. Set VITE_API_URL at build time; defaults to the deployed worker. */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://g2048-api.vivek.workers.dev';
export const MCP_URL: string = (import.meta.env.VITE_MCP_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://g2048-mcp.vivek.workers.dev/mcp';
/** Finished local games shorter than this are kept locally but never uploaded (mirrors the API's MIN_STORE_MOVES). */
export const MIN_UPLOAD_MOVES = 10;
