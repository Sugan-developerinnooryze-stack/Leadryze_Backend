import { Request } from 'express';
import { Document } from 'mongoose';

export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'AGENT' | 'USER';

export interface JwtPayload {
  userId:   string;
  tenantId: string;
  role:     UserRole;
  email:    string;
  roleId?:  string;   // DB role ID — undefined for legacy sessions (TENANT_ADMIN fast-path)
  iat?:     number;
  exp?:     number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  tenantId?: string;
  branchId?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export interface PaginationOptions {
  page: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
}

export interface AuditLogEntry {
  tenantId: string;
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string;
  userAgent: string;
  payload?: unknown;
  duration: number;
  timestamp: Date;
}
