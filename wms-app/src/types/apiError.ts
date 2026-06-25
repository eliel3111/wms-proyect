import type { ErrorCode } from "./errorCodes";


export interface ApiErrorResponse {
  success: false;
  code: ErrorCode;
  title?: string;
  message: string;
}
