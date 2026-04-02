// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';
import node from '@astrojs/node';

const normalizeBaseUrl = (value) => {
  if (!value || value.trim() === '') {
    return '/';
  }

  let normalized = value.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, '');
  return normalized || '/';
};

const base = normalizeBaseUrl(process.env.BASE_URL);

// https://astro.build/config
export default defineConfig({
  base,
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        external: ['bun', 'bun:*'],
      },
    },
  },
  integrations: [react()]
});
