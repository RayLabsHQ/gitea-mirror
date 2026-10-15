import { expect, test } from 'bun:test';
import type { ConfigApiResponse } from '@/types/config';
import { hasConfiguredSource } from './useConfigStatus';

test('App sources keep the dashboard configured when the private key is redacted', () => {
  const config = {
    githubConfig: { token: '' },
    sources: [{ provider: 'github', authType: 'app', token: '' }],
  } as ConfigApiResponse;
  expect(hasConfiguredSource(config)).toBe(true);
  expect(hasConfiguredSource({ ...config, sources: [{ provider: 'github', authType: 'pat', token: '' }] } as ConfigApiResponse)).toBe(false);
  expect(hasConfiguredSource({ ...config, githubConfig: { token: 'ghp_pat' }, sources: [] } as ConfigApiResponse)).toBe(true);
});