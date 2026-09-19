// Client-rendered SPA: the game engine runs in the browser, pages work offline
// from the service-worker cache, and Pages serves static files only.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
