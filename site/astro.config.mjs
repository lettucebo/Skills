import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://lettucebo.github.io',
  base: '/Skills',
  trailingSlash: 'always',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-tw', 'zh-cn'],
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
});
