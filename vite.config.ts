import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Cloudflare plugin is enabled for `vite build` only.
 *
 * With `@cloudflare/vite-plugin` 1.55 + `@tanstack/react-start` 1.168, running
 * `vite dev` inside the workerd runtime fails to resolve split server functions
 * ("Invalid server function ID: …"), so the two Jev calls 500 in dev. The build
 * output is unaffected and deploys to Workers as normal, so dev runs on Node and
 * the Workers runtime is used for the real thing. Drop the `command` check once
 * that combination is fixed upstream.
 */
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === 'build' ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}));
