// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://bona.azoz.uk',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ar'],
    routing: { prefixDefaultLocale: false },
  },
  image: {
    domains: ['tk-storage.azoz.uk', 'le-de.cdn-website.com', 'files.tk-estates.com'],
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/dashboard/'),
      i18n: { defaultLocale: 'en', locales: { en: 'en', ar: 'ar' } },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // Hoisted scripts are emitted as files, never inlined: the site ships a Content-Security-Policy <meta>, and the
    // ClientRouter's "inline module scripts have run" probe (an empty data: module script) would be refused by it
    // on every navigation. Files also cache across the 100+ pages instead of repeating in each one.
    build: { assetsInlineLimit: 0 },
  },
});
