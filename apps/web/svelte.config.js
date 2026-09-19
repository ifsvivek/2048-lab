import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
export default {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Deployed as a Cloudflare Worker with static assets. Asset requests are served
		// directly from the assets binding; the Worker handles app routes.
		adapter: adapter(),
		serviceWorker: { register: true }
	}
};
