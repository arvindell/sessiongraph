import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from 'posthog-js/dist/module.no-external';
import { analyticsConfig, analyticsPath } from '../analytics-config';

test('analytics is restricted to public production pages', () => {
  for (const [path, expected] of [['/', '/'], ['/index.html', '/'], ['/explore/', '/explore'], ['/privacy.html', '/privacy'], ['/@some-person', '/@:username']]) {
    assert.equal(analyticsPath(new URL(`https://sessiongraph.ai${path}?token=private#secret`)), expected);
  }
  for (const url of [
    'http://localhost:5190/', 'http://127.0.0.1:3000/', 'tauri://localhost/',
    'https://sessiongraph-preview.vercel.app/', 'https://evil.sessiongraph.ai/',
    'http://sessiongraph.ai/', 'https://sessiongraph.ai/account?code=private',
    'https://sessiongraph.ai/account.html', 'https://sessiongraph.ai/api/auth/callback?code=private',
    'https://sessiongraph.ai/private-token',
  ]) assert.equal(analyticsPath(new URL(url)), null, url);
});

test('only page events with allowlisted, anonymous metadata can leave the website', () => {
  const config = analyticsConfig(() => new URL('https://sessiongraph.ai/@private-username?q=private#token'), 'https://referrer.example/private?secret=yes', '/ingest');
  assert.equal(config.cookieless_mode, 'always');
  assert.equal(config.person_profiles, 'never');
  for (const key of ['autocapture', 'rageclick', 'capture_heatmaps', 'capture_performance', 'capture_exceptions'] as const) assert.equal(config[key], false);
  assert.equal(config.disable_session_recording, true);
  assert.equal(config.disable_surveys, true);
  assert.equal(config.disable_external_dependency_loading, true);
  const beforeSend = config.before_send as (event: CaptureResult | null) => CaptureResult | null;
  const event = {
    uuid: 'test-pageview',
    event: '$pageview',
    properties: {
      token: 'public-project-token',
      distinct_id: '$posthog_cookieless', $session_id: 'ephemeral-session', $browser: 'Firefox',
      $current_url: 'https://sessiongraph.ai/@private-username?q=private#token',
      $initial_current_url: 'https://sessiongraph.ai/account?code=private',
      $referrer: 'https://referrer.example/private?secret=yes',
      $set: { email: 'private@example.com' }, $set_once: { $initial_referrer: 'private' },
      email: 'private@example.com', $device_id: 'private', utm_campaign: 'private',
    },
  } as CaptureResult;
  const result = beforeSend(event)!;
  assert.equal(result.properties.$current_url, 'https://sessiongraph.ai/@:username');
  assert.equal(result.properties.$pathname, '/@:username');
  assert.equal(result.properties.$referring_domain, 'referrer.example');
  assert.equal(result.properties.$referrer, 'https://referrer.example/');
  assert.equal(result.properties.distinct_id, '$posthog_cookieless');
  assert.equal(result.properties.token, 'public-project-token');
  assert.equal(result.properties.$browser, 'Firefox');
  assert.equal(result.properties.$process_person_profile, false);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|email|utm_campaign|\$set/);
  assert.equal(beforeSend({ ...event, event: '$autocapture' }), null);
  assert.equal(beforeSend({ ...event, event: '$exception' }), null);
  assert.equal(beforeSend(null), null);
  assert.ok(beforeSend({ ...event, event: '$pageleave' }));
});

test('capture is dropped after navigation to an account or non-production page', () => {
  let url = new URL('https://sessiongraph.ai/');
  const config = analyticsConfig(() => url, '', '/ingest');
  const beforeSend = config.before_send as (event: CaptureResult) => CaptureResult | null;
  const event = { uuid: 'test-pageview', event: '$pageview', properties: {} } as CaptureResult;
  assert.equal(beforeSend(event)!.properties.$referrer, '');
  url = new URL('https://sessiongraph.ai/account?device_code=private');
  assert.equal(beforeSend(event), null);
  url = new URL('http://localhost:5190/');
  assert.equal(beforeSend(event), null);
});
