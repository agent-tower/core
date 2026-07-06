import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { ServiceError } from '../errors.js';
import { AccessAuthService } from '../services/access-auth.service.js';

const loginSchema = z.object({
  password: z.string().min(1),
});

const updateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().optional(),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: error.errors,
    };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return {
      error: error.message,
      code: error.code,
    };
  }

  reply.log.error(error);
  reply.code(500);
  return {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  };
}

export async function accessAuthRoutes(app: FastifyInstance) {
  app.get('/access-auth/status', async (request) => {
    const cookieToken = request.cookies[AccessAuthService.cookieName]
      ?? AccessAuthService.extractCookieFromHeader(request.headers.cookie);
    return AccessAuthService.getPublicStatus(cookieToken);
  });

  app.post('/access-auth/login', async (request, reply) => {
    try {
      const { password } = loginSchema.parse(request.body);
      const result = await AccessAuthService.login(password, request.ip);
      if (result.sessionToken) {
        reply.setCookie(
          AccessAuthService.cookieName,
          result.sessionToken,
          AccessAuthService.getCookieOptions(request),
        );
      }
      return result.status;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/access-auth/logout', async (request, reply) => {
    reply.clearCookie(
      AccessAuthService.cookieName,
      AccessAuthService.getClearCookieOptions(request),
    );

    const cookieToken = request.cookies[AccessAuthService.cookieName]
      ?? AccessAuthService.extractCookieFromHeader(request.headers.cookie);
    const status = await AccessAuthService.getPublicStatus(cookieToken);
    return {
      enabled: status.enabled,
      authenticated: !status.enabled,
    };
  });

  app.get('/access-auth/settings', async (_request, reply) => {
    try {
      return await AccessAuthService.getSettings();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put('/access-auth/settings', async (request, reply) => {
    try {
      const data = updateSettingsSchema.parse(request.body);
      const result = await AccessAuthService.updateSettings(data);
      if (result.clearSession) {
        reply.clearCookie(
          AccessAuthService.cookieName,
          AccessAuthService.getClearCookieOptions(request),
        );
      } else if (result.sessionToken) {
        reply.setCookie(
          AccessAuthService.cookieName,
          result.sessionToken,
          AccessAuthService.getCookieOptions(request),
        );
      }
      return result.settings;
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
