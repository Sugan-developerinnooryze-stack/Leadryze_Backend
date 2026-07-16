export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

export interface ListOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}
