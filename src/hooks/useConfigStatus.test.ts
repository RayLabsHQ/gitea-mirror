import { expect, test } from 'bun:test';
import type { ConfigApiResponse } from '@/types/config';
import { hasConfiguredSource } from './useConfigStatus';

const asConfig = (value: unknown) => value as ConfigApiResponse;

test('App sources keep the dashboard configured when the private key is redacted', () => {
  const config = {
    githubConfig: { token: '', hasToken: false },
    sources: [{ provider: 'github', authType: 'app', hasToken: false }],
  };
  expect(hasConfiguredSource(asConfig(config))).toBe(true);
  expect(hasConfiguredSource(asConfig({ ...config, sources: [{ provider: 'github', authType: 'pat', hasToken: false }] }))).toBe(false);
  expect(hasConfiguredSource(asConfig({ ...config, githubConfig: { token: 'ghp_pat' }, sources: [] }))).toBe(true);
});

test('a saved token counts although the API sends it back empty', () => {
  expect(hasConfiguredSource(asConfig({ githubConfig: { token: '', hasToken: true }, sources: [] }))).toBe(true);
});
