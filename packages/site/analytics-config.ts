import type { PostHogConfig } from 'posthog-js/dist/module.no-external';

/** Only public, hosted pages participate. Never initialize in the local app or account flow. */
export function analyticsPath(url: URL): string | null {
  if (url.protocol !== 'https:' || !['sessiongraph.ai', 'www.sessiongraph.ai'].includes(url.hostname)) return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/' || path === '/index.html') return '/';
  if (path === '/explore' || path === '/explore.html') return '/explore';
  if (path === '/privacy' || path === '/privacy.html') return '/privacy';
  if (/^\/@[a-z\d-]+$/i.test(path) || path === '/profile.html') return '/@:username';
  return null;
}

const technicalProperties = [
  'token', 'distinct_id', '$session_id', '$window_id', '$pageview_id', '$lib', '$lib_version',
  '$browser', '$browser_version', '$os', '$os_version', '$device', '$device_type',
  '$screen_height', '$screen_width', '$viewport_height', '$viewport_width', '$browser_language',
  '$timezone', '$timezone_offset', '$pageleave_reason', '$prev_pageview_duration',
  '$prev_pageview_max_scroll_percentage',
];

export function analyticsConfig(currentURL: () => URL, referrer: string, apiHost: string): Partial<PostHogConfig> {
  let referringDomain = '';
  try { referringDomain = new URL(referrer).hostname; } catch { /* Direct visit. */ }
  return {
    api_host: apiHost,
    ui_host: 'https://us.posthog.com',
    defaults: '2026-08-30',
    cookieless_mode: 'always',
    person_profiles: 'never',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    enable_recording_console_log: false,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    respect_dnt: true,
    before_send(event) {
      if (!event || !['$pageview', '$pageleave'].includes(event.event)) return null;
      const url = currentURL(), path = analyticsPath(url);
      if (!path) return null;
      // An allowlist also excludes SDK-added attribution, form data, query strings and fragments.
      const properties: Record<string, unknown> = {};
      for (const key of technicalProperties) {
        if (key in event.properties) properties[key] = event.properties[key];
      }
      properties.$host = url.host;
      properties.$pathname = path;
      properties.$current_url = `${url.origin}${path}`;
      properties.$referring_domain = referringDomain;
      properties.$referrer = referringDomain ? `https://${referringDomain}/` : '';
      properties.$process_person_profile = false;
      return { ...event, properties };
    },
  };
}
