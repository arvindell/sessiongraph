import { analyticsConfig, analyticsPath } from './analytics-config';

const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim();
const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };

if (analyticsPath(new URL(location.href)) && privacy.doNotTrack !== '1' && !privacy.globalPrivacyControl) {
  if (token && host) {
    // Keep analytics independent of page functionality and never fetch optional capture extensions.
    void import('posthog-js/dist/module.no-external').then(({ default: posthog }) => {
      posthog.init(token, analyticsConfig(() => new URL(location.href), document.referrer, host));
    }).catch(error => {
      // A blocked analytics download must not break the website.
      if (import.meta.env.DEV) console.warn('Website analytics unavailable', error);
    });
  } else if (import.meta.env.DEV) {
    console.warn(`${!token ? 'VITE_POSTHOG_PROJECT_TOKEN' : 'VITE_POSTHOG_HOST'} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once the variable is configured`);
  }
}
