import * as crypto from "crypto";

// Encryption configuration
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits
const ITERATIONS = 100000; // PBKDF2 iterations

// Get or generate encryption key
function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || process.env.BETTER_AUTH_SECRET;
  
  if (!secret) {
    throw new Error("No encryption secret found. Please set ENCRYPTION_SECRET environment variable.");
  }
  
  // Use a static salt derived from the secret for consistent key generation
  // This ensures the same key is generated across application restarts
  const salt = crypto.createHash('sha256').update('gitea-mirror-salt' + secret).digest();
  
  return crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

export interface EncryptedData {
  encrypted: string;
  iv: string;
  salt: string;
  tag: string;
  version: number;
}

/**
 * Encrypts sensitive data like API tokens
 * @param plaintext The data to encrypt
 * @returns Encrypted data with metadata
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) {
    return '';
  }

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();
    
    const encryptedData: EncryptedData = {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      salt: salt.toString('base64'),
      tag: tag.toString('base64'),
      version: 1
    };
    
    // Return as base64 encoded JSON for easy storage
    return Buffer.from(JSON.stringify(encryptedData)).toString('base64');
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts encrypted data
 * @param encryptedString The encrypted data string
 * @returns Decrypted plaintext
 */
export function decrypt(encryptedString: string): string {
  if (!encryptedString) {
    return '';
  }

  try {
    // Check if it's already plaintext (for backward compatibility during migration)
    if (!isEncrypted(encryptedString)) {
      return encryptedString;
    }
    
    const encryptedData: EncryptedData = JSON.parse(
      Buffer.from(encryptedString, 'base64').toString('utf8')
    );
    
    const key = getEncryptionKey();
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const tag = Buffer.from(encryptedData.tag, 'base64');
    const encrypted = Buffer.from(encryptedData.encrypted, 'base64');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  } catch (error) {
    // If decryption fails, check if it's plaintext (backward compatibility)
    try {
      JSON.parse(Buffer.from(encryptedString, 'base64').toString('utf8'));
      throw error; // It was encrypted but failed to decrypt
    } catch {
      // Not encrypted, return as-is for backward compatibility
      console.warn('Token appears to be unencrypted, returning as-is for backward compatibility');
      return encryptedString;
    }
  }
}

/**
 * Checks if a string is encrypted
 * @param value The string to check
 * @returns true if encrypted, false otherwise
 */
export function isEncrypted(value: string): boolean {
  if (!value) {
    return false;
  }
  
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    return data.version === 1 && data.encrypted && data.iv && data.tag;
  } catch {
    return false;
  }
}

/**
 * Migrates unencrypted tokens to encrypted format
 * @param token The token to migrate
 * @returns Encrypted token if it wasn't already encrypted
 */
export function migrateToken(token: string): string {
  if (!token || isEncrypted(token)) {
    return token;
  }
  
  return encrypt(token);
}

/**
 * Generates a secure random token
 * @param length Token length in bytes (default: 32)
 * @returns Hex encoded random token
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hashes a value using SHA-256 with a random salt (for non-reversible values like API keys)
 * @param value The value to hash
 * @returns Salt and hash in format "salt:hash"
 */
export function hashValue(value: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + value).digest('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifies a value against a salted hash produced by hashValue()
 * Uses constant-time comparison to prevent timing attacks
 */
export function verifyHash(value: string, saltedHash: string): boolean {
  const [salt, expectedHash] = saltedHash.split(':');
  if (!salt || !expectedHash) return false;
  const actualHash = crypto.createHash('sha256').update(salt + value).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
}