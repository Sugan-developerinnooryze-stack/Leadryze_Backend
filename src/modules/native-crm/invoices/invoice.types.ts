export interface InvoiceListOptions {
  page?:   number | string;
  limit?:  number | string;
  search?: string;
  status?: string;
  range?:     string;
  dateFrom?:  string;
  dateTo?:    string;
  filters?:   string;
  // Calendar addition — optional, every existing caller that omits it keeps
  // today's exact 'createdAt' behavior. The Calendar sends 'dueDate' so
  // events place on when the invoice is actually due, not when created.
  dateField?: 'dueDate' | 'createdAt';
}
