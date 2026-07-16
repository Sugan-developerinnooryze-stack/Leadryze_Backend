import { PaginationOptions } from '../types';

export function parsePagination(query: Record<string, unknown>): PaginationOptions {
  return {
    page: Math.max(1, parseInt(String(query.page || '1'), 10)),
    limit: Math.min(100, Math.max(1, parseInt(String(query.limit || '20'), 10))),
    sort: String(query.sort || 'createdAt'),
    order: query.order === 'asc' ? 'asc' : 'desc',
  };
}

export function buildSkip(page: number, limit: number): number {
  return (page - 1) * limit;
}
