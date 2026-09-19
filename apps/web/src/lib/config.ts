/** API origin. Set VITE_API_URL at build time; defaults to the deployed worker. */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://2048api.ifsvivek.in';
export const MCP_URL: string = (import.meta.env.VITE_MCP_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://2048mcp.ifsvivek.in/mcp';
/** Finished local games shorter than this are kept locally but never uploaded (mirrors the API's MIN_STORE_MOVES). */
export const MIN_UPLOAD_MOVES = 10;
