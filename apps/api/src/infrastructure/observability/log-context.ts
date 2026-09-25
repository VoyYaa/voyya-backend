export interface LogContext {
  requestId: string;
  userId?: number;
  companyId?: number;
  tripRequestId?: number;
  job?: string;
}
