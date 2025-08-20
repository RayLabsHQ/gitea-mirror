import { test, expect } from 'bun:test';
import { parseDuration, parseInterval, formatDuration, parseCronInterval } from './duration-parser';

test('parseDuration - handles duration strings correctly', () => {
  // Hours
  expect(parseDuration('8h')).toBe(8 * 60 * 60 * 1000);
  expect(parseDuration('1h')).toBe(60 * 60 * 1000);
  expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
  
  // Minutes
  expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  expect(parseDuration('5m')).toBe(5 * 60 * 1000);
  
  // Seconds
  expect(parseDuration('45s')).toBe(45 * 1000);
  expect(parseDuration('1s')).toBe(1000);
  
  // Days
  expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
  expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  
  // Numbers (treated as seconds)
  expect(parseDuration(3600)).toBe(3600 * 1000);
  expect(parseDuration('3600')).toBe(3600 * 1000);
});

test('parseDuration - handles edge cases', () => {
  // Case insensitive
  expect(parseDuration('8H')).toBe(8 * 60 * 60 * 1000);
  expect(parseDuration('30M')).toBe(30 * 60 * 1000);
  
  // With spaces
  expect(parseDuration('8 h')).toBe(8 * 60 * 60 * 1000);
  expect(parseDuration('30 minutes')).toBe(30 * 60 * 1000);
  
  // Fractional values
  expect(parseDuration('1.5h')).toBe(1.5 * 60 * 60 * 1000);
  expect(parseDuration('2.5m')).toBe(2.5 * 60 * 1000);
});

test('parseDuration - throws on invalid input', () => {
  expect(() => parseDuration('')).toThrow();
  expect(() => parseDuration('invalid')).toThrow();
  expect(() => parseDuration('8x')).toThrow();
  expect(() => parseDuration('-1h')).toThrow();
});

test('parseInterval - handles cron expressions', () => {
  // Every 2 hours
  expect(parseInterval('0 */2 * * *')).toBe(2 * 60 * 60 * 1000);
  
  // Every 15 minutes
  expect(parseInterval('*/15 * * * *')).toBe(15 * 60 * 1000);
  
  // Daily at 2 AM
  expect(parseInterval('0 2 * * *')).toBe(24 * 60 * 60 * 1000);
});

test('parseInterval - prioritizes duration strings over cron', () => {
  expect(parseInterval('8h')).toBe(8 * 60 * 60 * 1000);
  expect(parseInterval('30m')).toBe(30 * 60 * 1000);
  expect(parseInterval(3600)).toBe(3600 * 1000);
});

test('formatDuration - converts milliseconds back to readable format', () => {
  expect(formatDuration(1000)).toBe('1s');
  expect(formatDuration(60 * 1000)).toBe('1m');
  expect(formatDuration(60 * 60 * 1000)).toBe('1h');
  expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1d');
  expect(formatDuration(8 * 60 * 60 * 1000)).toBe('8h');
  expect(formatDuration(500)).toBe('500ms');
});

test('parseCronInterval - handles common cron patterns', () => {
  expect(parseCronInterval('0 */8 * * *')).toBe(8 * 60 * 60 * 1000);
  expect(parseCronInterval('*/30 * * * *')).toBe(30 * 60 * 1000);
  expect(parseCronInterval('0 2 * * *')).toBe(24 * 60 * 60 * 1000);
  expect(parseCronInterval('0 0 * * 0')).toBe(7 * 24 * 60 * 60 * 1000); // Weekly
});

test('Integration test - Issue #72 scenario', () => {
  // User sets GITEA_MIRROR_INTERVAL=8h
  const userInterval = '8h';
  const parsedMs = parseInterval(userInterval);
  
  expect(parsedMs).toBe(8 * 60 * 60 * 1000); // 8 hours in milliseconds
  expect(formatDuration(parsedMs)).toBe('8h');
  
  // Should work from container startup time
  const startTime = new Date();
  const nextRun = new Date(startTime.getTime() + parsedMs);
  
  expect(nextRun.getTime() - startTime.getTime()).toBe(8 * 60 * 60 * 1000);
});