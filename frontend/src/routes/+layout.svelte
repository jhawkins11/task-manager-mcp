<script lang="ts">
	import '../app.pcss';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	// Removed prerender export - moved to +layout.server.ts

	onMount(() => {
		// Run only in the browser
		if (browser) {
			const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

			const updateTheme = (event: MediaQueryListEvent | MediaQueryList) => {
				if (event.matches) {
					document.documentElement.classList.add('dark');
				} else {
					document.documentElement.classList.remove('dark');
				}
			};

			// Initial check
			updateTheme(mediaQuery);

			// Listen for changes
			mediaQuery.addEventListener('change', updateTheme);

			// Cleanup listener on component destroy
			return () => {
				mediaQuery.removeEventListener('change', updateTheme);
			};
		}
	});
</script>

<div class="min-h-screen bg-background text-foreground">
	<main class="min-h-screen">
		<slot />
	</main>
</div> 