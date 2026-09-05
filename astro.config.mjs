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
  vite: { plugins: [tailwindcss()] },
});
