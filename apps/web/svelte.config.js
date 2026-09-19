import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
export default {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Static SPA on Cloudflare Pages: zero Functions invocations, fully cacheable,
		// and the service worker can serve the whole app offline.
		adapter: adapter({ fallback: 'index.html', precompress: false, strict: false }),
		serviceWorker: { register: true }
	}
};
