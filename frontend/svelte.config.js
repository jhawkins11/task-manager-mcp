import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Consult https://svelte.dev/docs/kit/integrations
  // for more information about preprocessors
  preprocess: vitePreprocess(),

  kit: {
    // Using adapter-static to output a static site build
    adapter: adapter({
      // Output to the default build folder
      pages: 'build',
      assets: 'build',
      precompress: false,
    }),
  },
}

export default config
