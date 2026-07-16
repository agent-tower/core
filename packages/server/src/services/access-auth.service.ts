import { promisify } from 'node:util';
import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type {
  AccessAuthPublicStatus,
  AccessAuthSafeSettings,
  UpdateAccessAuthSettingsInput,
} from '@agent-tower/shared';
import { ServiceError, ValidationError } from '../errors.js';
import { getEventBus } from '../core/container.js';
import { prisma } from '../utils/index.js';
import { PREVIEW_ACCESS_TOKEN_VERSION } from '../utils/preview-path.js';

const scrypt = promisify(scryptCallback);

export const ACCESS_AUTH_COOKIE_NAME = 'agent-tower-access';
export const ACCESS_AUTH_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SETTINGS_ID = 'singleton';
const PASSWORD_HASH_PREFIX = 'scrypt:v1';
const SESSION_TOKEN_PREFIX = 'v1';
const PASSWORD_KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 60 * 1000;
const PREVIEW_ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;

type AccessAuthSettingsRecord = {
  id: string;
  enabled: boolean;
  passwordHash: string | null;
  sessionSecret: string;
  passwordUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type LoginAttemptState = {
  failedCount: number;
  lastFailedAtMs: number;
  lockedUntilMs: number;
};

const loginAttempts = new Map<string, LoginAttemptState>();
let nowMs = () => Date.now();
let sessionSecretGeneration = 0;
let onBeforeValidateSessionTokenWithGeneration: (() => void) | null = null;
let settingsCache: AccessAuthSettingsRecord | null = null;
let settingsLoadPromise: Promise<AccessAuthSettingsRecord> | null = null;
let settingsDatabaseLoadCount = 0;

export class AccessAuthError extends ServiceError {
  constructor(message: string, code: string, statusCode = 400) {
    super(message, code, statusCode);
    this.name = 'AccessAuthError';
  }
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function toSafeSettings(settings: AccessAuthSettingsRecord): AccessAuthSafeSettings {
  return {
    enabled: settings.enabled,
    passwordConfigured: Boolean(settings.passwordHash),
    passwordUpdatedAt: settings.passwordUpdatedAt?.toISOString() ?? null,
  };
}

function assertPasswordInput(password: string, field = 'Password'): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`${field} must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function normalizeLoginIdentifier(identifier?: string): string {
  const value = identifier?.trim();
  return value ? value.slice(0, 128) : 'global';
}

function getActiveLoginAttempt(key: string, now: number): LoginAttemptState | null {
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  if (now - entry.lastFailedAtMs > LOGIN_ATTEMPT_WINDOW_MS && entry.lockedUntilMs <= now) {
    loginAttempts.delete(key);
    return null;
  }
  return entry;
}

function assertLoginNotRateLimited(key: string): void {
  const now = nowMs();
  const entry = getActiveLoginAttempt(key, now);
  if (entry && entry.lockedUntilMs > now) {
    throw new AccessAuthError('Too many login attempts. Try again later.', 'ACCESS_AUTH_RATE_LIMITED', 429);
  }
}

function recordLoginFailure(key: string): void {
  const now = nowMs();
  const entry = getActiveLoginAttempt(key, now);
  const failedCount = (entry?.failedCount ?? 0) + 1;
  loginAttempts.set(key, {
    failedCount,
    lastFailedAtMs: now,
    lockedUntilMs: failedCount >= MAX_FAILED_LOGIN_ATTEMPTS ? now + LOGIN_COOLDOWN_MS : 0,
  });
}

function recordLoginSuccess(key: string): void {
  loginAttempts.delete(key);
}

function splitCookieHeader(cookieHeader?: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!cookieHeader) return result;

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    result.set(rawName, decodeURIComponent(rawValue.join('=')));
  }

  return result;
}

function signSessionPayload(secret: string, expiresAtMs: number, nonce: string): string {
  return createHmac('sha256', secret)
    .update(`${SESSION_TOKEN_PREFIX}.${expiresAtMs}.${nonce}`)
    .digest('base64url');
}

function encodePreviewWorkspaceId(workspaceId: string): string {
  return Buffer.from(workspaceId, 'utf8').toString('base64url');
}

function signPreviewAccessPayload(
  secret: string,
  workspaceId: string,
  expiresAtMs: number,
  nonce: string,
): string {
  return createHmac('sha256', secret)
    .update(`${PREVIEW_ACCESS_TOKEN_VERSION}.${encodePreviewWorkspaceId(workspaceId)}.${expiresAtMs}.${nonce}`)
    .digest('base64url');
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https') {
    return true;
  }
  return request.protocol === 'https';
}

async function hashPassword(password: string): Promise<string> {
  assertPasswordInput(password);
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  return `${PASSWORD_HASH_PREFIX}:${salt}:${key.toString('base64url')}`;
}

async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  if (!passwordHash) return false;

  const [scheme, version, salt, expected] = passwordHash.split(':');
  if (`${scheme}:${version}` !== PASSWORD_HASH_PREFIX || !salt || !expected) return false;

  const actualKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  const expectedKey = Buffer.from(expected, 'base64url');
  if (actualKey.length !== expectedKey.length) return false;
  return timingSafeEqual(actualKey, expectedKey);
}

async function ensureSettings(): Promise<AccessAuthSettingsRecord> {
  if (settingsCache) {
    return settingsCache;
  }
  if (settingsLoadPromise) {
    return settingsLoadPromise;
  }

  const loadPromise = (async () => {
    settingsDatabaseLoadCount += 1;
    const existing = await prisma.accessAuthSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (existing) return existing;

    return prisma.accessAuthSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        enabled: false,
        sessionSecret: newSecret(),
      },
      update: {},
    });
  })();
  settingsLoadPromise = loadPromise;

  try {
    const settings = await loadPromise;
    settingsCache = settings;
    return settings;
  } finally {
    if (settingsLoadPromise === loadPromise) {
      settingsLoadPromise = null;
    }
  }
}

function notifySessionSecretRotated(): void {
  sessionSecretGeneration += 1;
  getEventBus().emit('access-auth:session-secret-rotated', {
    generation: sessionSecretGeneration,
  });
}

function extractAccessAuthCookie(cookieHeader?: string): string | null {
  return splitCookieHeader(cookieHeader).get(ACCESS_AUTH_COOKIE_NAME) ?? null;
}

function createSessionToken(settings: AccessAuthSettingsRecord): string {
  const expiresAtMs = Date.now() + ACCESS_AUTH_SESSION_MAX_AGE_SECONDS * 1000;
  const nonce = randomBytes(16).toString('base64url');
  const signature = signSessionPayload(settings.sessionSecret, expiresAtMs, nonce);
  return `${SESSION_TOKEN_PREFIX}.${expiresAtMs}.${nonce}.${signature}`;
}

function createPreviewAccessToken(settings: AccessAuthSettingsRecord, workspaceId: string): string {
  const expiresAtMs = nowMs() + PREVIEW_ACCESS_TOKEN_TTL_MS;
  const nonce = randomBytes(16).toString('base64url');
  const encodedWorkspaceId = encodePreviewWorkspaceId(workspaceId);
  const signature = signPreviewAccessPayload(settings.sessionSecret, workspaceId, expiresAtMs, nonce);
  return `${PREVIEW_ACCESS_TOKEN_VERSION}.${encodedWorkspaceId}.${expiresAtMs}.${nonce}.${signature}`;
}

function validateSessionToken(token: string | null, settings: AccessAuthSettingsRecord): boolean {
  if (!settings.enabled || !settings.passwordHash || !token) return !settings.enabled;

  const [version, rawExpiresAt, nonce, signature] = token.split('.');
  if (version !== SESSION_TOKEN_PREFIX || !rawExpiresAt || !nonce || !signature) return false;

  const expiresAtMs = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  const expected = signSessionPayload(settings.sessionSecret, expiresAtMs, nonce);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function validatePreviewAccessToken(
  token: string | null,
  workspaceId: string,
  settings: AccessAuthSettingsRecord,
): boolean {
  if (!token) return false;

  const [version, encodedWorkspaceId, rawExpiresAt, nonce, signature] = token.split('.');
  if (
    version !== PREVIEW_ACCESS_TOKEN_VERSION
    || encodedWorkspaceId !== encodePreviewWorkspaceId(workspaceId)
    || !rawExpiresAt
    || !nonce
    || !signature
  ) {
    return false;
  }

  const expiresAtMs = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) return false;

  const expected = signPreviewAccessPayload(settings.sessionSecret, workspaceId, expiresAtMs, nonce);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export const AccessAuthService = {
  cookieName: ACCESS_AUTH_COOKIE_NAME,

  getCookieOptions(request: FastifyRequest, maxAge = ACCESS_AUTH_SESSION_MAX_AGE_SECONDS) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isSecureRequest(request),
      path: '/',
      maxAge,
    };
  },

  getClearCookieOptions(request: FastifyRequest) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isSecureRequest(request),
      path: '/',
    };
  },

  extractCookieFromHeader: extractAccessAuthCookie,

  async getSettings(): Promise<AccessAuthSafeSettings> {
    return toSafeSettings(await ensureSettings());
  },

  async getPublicStatus(cookieToken: string | null): Promise<AccessAuthPublicStatus> {
    const settings = await ensureSettings();
    return {
      enabled: settings.enabled,
      authenticated: settings.enabled ? validateSessionToken(cookieToken, settings) : true,
    };
  },

  async isEnabled(): Promise<boolean> {
    const settings = await ensureSettings();
    return settings.enabled;
  },

  async validateSessionToken(cookieToken: string | null): Promise<boolean> {
    const settings = await ensureSettings();
    return validateSessionToken(cookieToken, settings);
  },

  async validateSessionTokenWithGeneration(
    cookieToken: string | null,
  ): Promise<{ valid: boolean; generation: number }> {
    const generation = sessionSecretGeneration;
    const settings = await ensureSettings();
    onBeforeValidateSessionTokenWithGeneration?.();
    const valid = validateSessionToken(cookieToken, settings)
      && generation === sessionSecretGeneration;
    return { valid, generation };
  },

  getSessionSecretGeneration(): number {
    return sessionSecretGeneration;
  },

  async createPreviewAccessToken(workspaceId: string): Promise<string> {
    const settings = await ensureSettings();
    return createPreviewAccessToken(settings, workspaceId);
  },

  async validatePreviewAccessToken(token: string | null, workspaceId: string): Promise<boolean> {
    const settings = await ensureSettings();
    return validatePreviewAccessToken(token, workspaceId, settings);
  },

  async login(
    password: string,
    identifier?: string,
  ): Promise<{ status: AccessAuthPublicStatus; sessionToken: string | null }> {
    const settings = await ensureSettings();
    if (!settings.enabled) {
      return {
        status: { enabled: false, authenticated: true },
        sessionToken: null,
      };
    }

    const loginKey = normalizeLoginIdentifier(identifier);
    assertLoginNotRateLimited(loginKey);

    if (!await verifyPassword(password, settings.passwordHash)) {
      recordLoginFailure(loginKey);
      throw new AccessAuthError('Invalid access password', 'ACCESS_AUTH_INVALID_PASSWORD', 401);
    }

    recordLoginSuccess(loginKey);
    return {
      status: { enabled: true, authenticated: true },
      sessionToken: createSessionToken(settings),
    };
  },

  async updateSettings(input: UpdateAccessAuthSettingsInput): Promise<{
    settings: AccessAuthSafeSettings;
    sessionToken: string | null;
    clearSession: boolean;
  }> {
    const current = await ensureSettings();
    const wantsDisable = input.enabled === false;
    const wantsEnable = input.enabled === true;
    const newPassword = input.newPassword;
    const currentPassword = input.currentPassword ?? '';

    if (current.enabled && (wantsDisable || newPassword)) {
      if (!currentPassword || !await verifyPassword(currentPassword, current.passwordHash)) {
        throw new AccessAuthError('Current password is incorrect', 'ACCESS_AUTH_INVALID_CURRENT_PASSWORD', 401);
      }
    }

    if (!current.enabled && wantsEnable && !newPassword) {
      throw new ValidationError('New password is required when enabling access password');
    }

    if (newPassword) {
      assertPasswordInput(newPassword, 'New password');
    }

    if (wantsDisable) {
      const settings = await prisma.accessAuthSettings.update({
        where: { id: SETTINGS_ID },
        data: {
          enabled: false,
          passwordHash: null,
          sessionSecret: newSecret(),
        },
      });
      settingsCache = settings;
      notifySessionSecretRotated();
      return {
        settings: toSafeSettings(settings),
        sessionToken: null,
        clearSession: true,
      };
    }

    if (wantsEnable || newPassword) {
      const passwordHash = newPassword ? await hashPassword(newPassword) : current.passwordHash;
      if (!passwordHash) {
        throw new ValidationError('New password is required');
      }

      const settings = await prisma.accessAuthSettings.update({
        where: { id: SETTINGS_ID },
        data: {
          enabled: wantsEnable || current.enabled,
          passwordHash,
          passwordUpdatedAt: new Date(),
          sessionSecret: newSecret(),
        },
      });
      settingsCache = settings;
      notifySessionSecretRotated();

      return {
        settings: toSafeSettings(settings),
        sessionToken: createSessionToken(settings),
        clearSession: false,
      };
    }

    return {
      settings: toSafeSettings(current),
      sessionToken: null,
      clearSession: false,
    };
  },

  async disableForRecovery(): Promise<void> {
    settingsCache = await prisma.accessAuthSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        enabled: false,
        passwordHash: null,
        sessionSecret: newSecret(),
      },
      update: {
        enabled: false,
        passwordHash: null,
        sessionSecret: newSecret(),
      },
    });
    notifySessionSecretRotated();
  },

  __test: {
    MIN_PASSWORD_LENGTH,
    MAX_FAILED_LOGIN_ATTEMPTS,
    LOGIN_COOLDOWN_MS,
    PREVIEW_ACCESS_TOKEN_TTL_MS,
    hashPassword,
    verifyPassword,
    validateSessionToken,
    createSessionToken,
    createPreviewAccessToken,
    validatePreviewAccessToken,
    resetSessionSecretGeneration() {
      sessionSecretGeneration = 0;
      onBeforeValidateSessionTokenWithGeneration = null;
    },
    notifySessionSecretRotated,
    setBeforeValidateSessionTokenWithGenerationHook(hook: (() => void) | null) {
      onBeforeValidateSessionTokenWithGeneration = hook;
    },
    resetLoginRateLimit() {
      loginAttempts.clear();
      nowMs = () => Date.now();
    },
    setLoginRateLimitClock(clock: () => number) {
      nowMs = clock;
    },
    resetSettingsCache() {
      settingsCache = null;
      settingsLoadPromise = null;
      settingsDatabaseLoadCount = 0;
    },
    getSettingsDatabaseLoadCount() {
      return settingsDatabaseLoadCount;
    },
  },
};
