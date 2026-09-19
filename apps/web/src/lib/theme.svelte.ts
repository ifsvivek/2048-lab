class Theme {
	dark = $state(typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
	toggle() {
		this.dark = !this.dark;
		document.documentElement.classList.toggle('dark', this.dark);
		localStorage.setItem('theme', this.dark ? 'dark' : 'light');
	}
}
export const theme = new Theme();

class Online {
	value = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
	constructor() {
		if (typeof window === 'undefined') return;
		addEventListener('online', () => (this.value = true));
		addEventListener('offline', () => (this.value = false));
	}
}
export const online = new Online();
