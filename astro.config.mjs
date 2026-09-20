// @ts-check
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

/**
 * @astrojs/sitemap emits `sitemap-index.xml` (+ `sitemap-0.xml`), and robots.txt points there —
 * that is how Google and Bing actually discover it, and that already works.
 *
 * This alias is a compatibility measure, not a ranking one: plenty of SEO auditors, link
 * checkers and AI crawlers probe the conventional `/sitemap.xml` directly, and on GitHub Pages
 * there is no server to redirect them, so they get a 404 that reads as "this site has no
 * sitemap". Publishing the same index under that name removes the false negative. Both files
 * are byte-identical <sitemapindex> documents pointing at the same absolute /sitemap-0.xml,
 * so no page URL is duplicated and no canonical signal changes.
 */
/** @type {import('astro').AstroIntegration} */
const sitemapAlias = {
  name: 'bona:sitemap-alias',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const src = fileURLToPath(new URL('./sitemap-index.xml', dir));
      const dest = fileURLToPath(new URL('./sitemap.xml', dir));
      // Deliberately uncaught: swallowing a failure here would ship a deploy whose /sitemap.xml
      // 404s again, silently undoing the fix. Fail the build instead so CI catches it.
      await copyFile(src, dest);
      logger.info('sitemap.xml written as an alias of sitemap-index.xml');
    },
  },
};

export default defineConfig({
  site: 'https://bona-real-estate.com',
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
      // `/dashboard/` is private; `/ig/` is a redirect, not a destination. Submitting a
      // noindex URL in the sitemap is a contradictory signal — it asks Google to crawl a
      // page that then tells it not to index — and risks /ig/ being surfaced in place of
      // the homepage.
      filter: (page) => !page.includes('/dashboard/') && !page.includes('/ig/'),
      i18n: { defaultLocale: 'en', locales: { en: 'en', ar: 'ar' } },
    }),
    sitemapAlias,
  ],
  vite: {
    plugins: [tailwindcss()],
    // Hoisted scripts are emitted as files, never inlined: the site ships a Content-Security-Policy <meta>, and the
    // ClientRouter's "inline module scripts have run" probe (an empty data: module script) would be refused by it
    // on every navigation. Files also cache across the 100+ pages instead of repeating in each one.
    build: { assetsInlineLimit: 0 },
  },
});
