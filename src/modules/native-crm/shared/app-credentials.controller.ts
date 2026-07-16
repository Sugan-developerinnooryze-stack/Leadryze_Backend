import { Response } from 'express';
import mongoose, { Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { encrypt } from '../../../utils/crypto';
import {
  buildCredentialFields,
  generatePassword,
  revealPassword,
} from './app-credentials.service';

export const credentialsUpdateSchema = z.object({
  username: z.string().trim().toLowerCase().min(4).max(30).regex(/^[a-z0-9]+$/, 'Username must be lowercase letters and digits only').optional(),
  password: z.string().min(6).max(64).optional(),
});

const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

function isAdmin(req: AuthRequest): boolean {
  return ADMIN_ROLES.includes(req.user?.role ?? '');
}

const CRED_SELECT = '+appPasswordHash +appPasswordEnc';

function credentialResponse(doc: any) {
  return {
    clientId:    doc.clientId ?? '',
    username:    doc.appUsername ?? '',
    password:    revealPassword(doc.appPasswordEnc),
    generatedAt: doc.appCredentialsGeneratedAt ?? null,
    lastLoginAt: doc.appLastLoginAt ?? null,
  };
}

/**
 * Factory producing app-credential handlers for a staff/customer model.
 * `nameOf(doc)` supplies the base name used for lazy username generation.
 */
export function makeCredentialHandlers(model: Model<any>, nameOf: (doc: any) => string) {
  async function findDoc(req: AuthRequest) {
    const tid = new mongoose.Types.ObjectId(req.tenantId!);
    return model.findOne({ _id: req.params.id, tenantId: tid }).select(CRED_SELECT);
  }

  return {
    /** GET /:id/credentials — lazily generates credentials for legacy records. */
    async getCredentials(req: AuthRequest, res: Response) {
      try {
        if (!isAdmin(req)) return sendError(res, 'Only admins can view credentials', 403);
        let doc = await findDoc(req);
        if (!doc) return sendError(res, 'Record not found', 404);

        if (!doc.appUsername) {
          const fields = await buildCredentialFields(nameOf(doc), doc.tenantId, model);
          const { plainPassword: _pw, ...toSet } = fields;
          await model.updateOne({ _id: doc._id }, { $set: toSet });
          doc = await findDoc(req);
        }
        sendSuccess(res, credentialResponse(doc));
      } catch (err: any) {
        sendError(res, err.message, 500);
      }
    },

    /** PATCH /:id/credentials — update username and/or password. clientId is never editable. */
    async updateCredentials(req: AuthRequest, res: Response) {
      try {
        if (!isAdmin(req)) return sendError(res, 'Only admins can update credentials', 403);
        const { username, password } = req.body as { username?: string; password?: string };
        if (!username && !password) return sendError(res, 'Nothing to update', 400);

        const doc = await findDoc(req);
        if (!doc) return sendError(res, 'Record not found', 404);

        const set: Record<string, unknown> = {};
        if (username && username !== doc.appUsername) {
          const taken = await model.exists({
            tenantId: doc.tenantId,
            appUsername: username,
            _id: { $ne: doc._id },
          });
          if (taken) return sendError(res, 'Username already taken', 409);
          set.appUsername = username;
        }
        if (password) {
          set.appPasswordHash = await bcrypt.hash(password, 10);
          set.appPasswordEnc  = encrypt(password);
          set.appCredentialsGeneratedAt = new Date();
        }
        if (Object.keys(set).length) await model.updateOne({ _id: doc._id }, { $set: set });

        const fresh = await findDoc(req);
        sendSuccess(res, credentialResponse(fresh), 'Credentials updated');
      } catch (err: any) {
        sendError(res, err.message, 500);
      }
    },

    /** POST /:id/credentials/regenerate — issue a fresh random password. */
    async regeneratePassword(req: AuthRequest, res: Response) {
      try {
        if (!isAdmin(req)) return sendError(res, 'Only admins can regenerate credentials', 403);
        const doc = await findDoc(req);
        if (!doc) return sendError(res, 'Record not found', 404);

        const newPassword = generatePassword();
        await model.updateOne({ _id: doc._id }, {
          $set: {
            appPasswordHash: await bcrypt.hash(newPassword, 10),
            appPasswordEnc:  encrypt(newPassword),
            appCredentialsGeneratedAt: new Date(),
          },
        });
        const fresh = await findDoc(req);
        sendSuccess(res, credentialResponse(fresh), 'Password regenerated');
      } catch (err: any) {
        sendError(res, err.message, 500);
      }
    },
  };
}
