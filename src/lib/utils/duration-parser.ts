/**
 * Duration parser utility for converting human-readable duration strings to milliseconds
 * Supports formats like: 8h, 30m, 24h, 1d, 5s, etc.
 */

export interface ParsedDuration {
  value: number;
  unit: string;
  milliseconds: number;
}

/**
 * Parse a duration string into milliseconds
 * @param duration - Duration string (e.g., "8h", "30m", "1d", "5s") or number in seconds
 * @returns Duration in milliseconds
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') {
    return duration * 1000; // Convert seconds to milliseconds
  }

  if (!duration || typeof duration !== 'string') {
    throw new Error('Invalid duration: must be a string or number');
  }

  // Try to parse as number first (assume seconds)
  const parsed = parseInt(duration, 10);
  if (!isNaN(parsed) && duration === parsed.toString()) {
    return parsed * 1000; // Convert seconds to milliseconds
  }

  // Parse duration string with unit
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected format like "8h", "30m", "1d"`);
  }

  const [, valueStr, unit] = match;
  const value = parseFloat(valueStr);

  if (isNaN(value) || value < 0) {
    throw new Error(`Invalid duration value: "${valueStr}". Must be a positive number`);
  }

  const unitLower = unit.toLowerCase();
  let multiplier: number;

  switch (unitLower) {
    case 'ms':
    case 'millisecond':
    case 'milliseconds':
      multiplier = 1;
      break;
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      multiplier = 1000;
      break;
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      multiplier = 60 * 1000;
      break;
    case 'h':
    case 'hr':
    case 'hour':
    case 'hours':
      multiplier = 60 * 60 * 1000;
      break;
    case 'd':
    case 'day':
    case 'days':
      multiplier = 24 * 60 * 60 * 1000;
      break;
    case 'w':
    case 'week':
    case 'weeks':
      multiplier = 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`Unsupported duration unit: "${unit}". Supported units: ms, s, m, h, d, w`);
  }

  return Math.floor(value * multiplier);
}

/**
 * Parse a duration string and return detailed information
 * @param duration - Duration string
 * @returns Parsed duration with value, unit, and milliseconds
 */
export function parseDurationDetailed(duration: string | number): ParsedDuration {
  const milliseconds = parseDuration(duration);
  
  if (typeof duration === 'number') {
    return {
      value: duration,
      unit: 's',
      milliseconds
    };
  }

  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) {
    // If it's just a number as string
    const value = parseFloat(duration);
    if (!isNaN(value)) {
      return {
        value,
        unit: 's',
        milliseconds
      };
    }
    throw new Error(`Invalid duration format: "${duration}"`);
  }

  const [, valueStr, unit] = match;
  return {
    value: parseFloat(valueStr),
    unit: unit.toLowerCase(),
    milliseconds
  };
}

/**
 * Format milliseconds back to human-readable duration
 * @param milliseconds - Duration in milliseconds
 * @returns Human-readable duration string
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Parse cron expression to approximate milliseconds interval
 * This is a simplified parser for common cron patterns
 * @param cron - Cron expression
 * @returns Approximate interval in milliseconds
 */
export function parseCronInterval(cron: string): number {
  if (!cron || typeof cron !== 'string') {
    throw new Error('Invalid cron expression');
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 parts (minute hour day month weekday)');
  }

  const [minute, hour, day, month, weekday] = parts;

  // Extract hour interval from patterns like "*/2" (every 2 hours)
  if (hour.includes('*/')) {
    const everyMatch = hour.match(/\*\/(\d+)/);
    if (everyMatch) {
      const hours = parseInt(everyMatch[1], 10);
      return hours * 60 * 60 * 1000; // Convert hours to milliseconds
    }
  }

  // Extract minute interval from patterns like "*/15" (every 15 minutes)
  if (minute.includes('*/')) {
    const everyMatch = minute.match(/\*\/(\d+)/);
    if (everyMatch) {
      const minutes = parseInt(everyMatch[1], 10);
      return minutes * 60 * 1000; // Convert minutes to milliseconds
    }
  }

  // Daily patterns like "0 2 * * *" (daily at 2 AM)
  if (hour !== '*' && minute !== '*' && day === '*' && month === '*' && weekday === '*') {
    return 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  }

  // Weekly patterns
  if (weekday !== '*') {
    return 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
  }

  // Monthly patterns
  if (day !== '*') {
    return 30 * 24 * 60 * 60 * 1000; // Approximate month (30 days)
  }

  // Default to 1 hour if unable to parse
  return 60 * 60 * 1000;
}

/**
 * Enhanced interval parser that handles duration strings, cron expressions, and numbers
 * @param interval - Interval specification (duration string, cron, or number)
 * @returns Interval in milliseconds
 */
export function parseInterval(interval: string | number): number {
  if (typeof interval === 'number') {
    return interval * 1000; // Convert seconds to milliseconds
  }

  if (!interval || typeof interval !== 'string') {
    throw new Error('Invalid interval: must be a string or number');
  }

  const trimmed = interval.trim();

  // Check if it's a cron expression (contains spaces and specific patterns)
  if (trimmed.includes(' ') && trimmed.split(/\s+/).length === 5) {
    try {
      return parseCronInterval(trimmed);
    } catch (error) {
      console.warn(`Failed to parse as cron expression: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Fall through to duration parsing
    }
  }

  // Try to parse as duration string
  try {
    return parseDuration(trimmed);
  } catch (error) {
    console.warn(`Failed to parse as duration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    
    // Last resort: try as plain number (seconds)
    const parsed = parseInt(trimmed, 10);
    if (!isNaN(parsed)) {
      return parsed * 1000;
    }
    
    throw new Error(`Unable to parse interval: "${interval}". Expected duration (e.g., "8h"), cron expression (e.g., "0 */2 * * *"), or number of seconds`);
  }
}