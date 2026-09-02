import type { CatalogData, SkillViewModel } from '../lib/catalog.ts';
import {
  SITE_BASE,
  SUPPORTED_LOCALES,
  localizedPath,
  type Locale,
} from './index.ts';

export interface RouteEntry {
  locale: Locale;
  route: string;
  path: string;
}

export interface LegacyRedirectEntry {
  from: string;
  to: string;
}

export function localizedSourcePaths(
  catalog: CatalogData,
  locale: Locale,
): RouteEntry[] {
  return catalog.sources.map((source) => {
    const route = `sources/${source}`;
    return { locale, route, path: localizedPath(locale, route) };
  });
}

export function localizedSkillPaths(
  catalog: CatalogData,
  locale: Locale,
): Array<RouteEntry & { skill: SkillViewModel }> {
  return catalog.skills
    .filter((skill) => !skill.isTombstone)
    .map((skill) => {
      const route = `skills/${skill.source}/${skill.slug}`;
      return {
        locale,
        route,
        path: localizedPath(locale, route),
        skill,
      };
    });
}

export function getLocalizedRouteEntries(catalog: CatalogData): RouteEntry[] {
  return SUPPORTED_LOCALES.flatMap((locale) => [
    { locale, route: '', path: localizedPath(locale) },
    { locale, route: 'install', path: localizedPath(locale, 'install') },
    { locale, route: 'status', path: localizedPath(locale, 'status') },
    ...localizedSourcePaths(catalog, locale),
    ...localizedSkillPaths(catalog, locale),
  ]);
}

export function getLegacyRedirectEntries(
  catalog: CatalogData,
): LegacyRedirectEntry[] {
  const routes = [
    '',
    'install',
    'status',
    ...catalog.sources.map((source) => `sources/${source}`),
    ...catalog.skills
      .filter((skill) => !skill.isTombstone)
      .map((skill) => `skills/${skill.source}/${skill.slug}`),
  ];

  return routes.map((route) => ({
    from: localizedPathWithoutLocale(route),
    to: localizedPath('en', route),
  }));
}

export function localizedPathWithoutLocale(route = ''): string {
  const rest = route.replace(/^\/+|\/+$/g, '');
  return `${SITE_BASE}${rest ? `${rest}/` : ''}`;
}
