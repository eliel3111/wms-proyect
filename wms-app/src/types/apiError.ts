import type { ErrorCode } from "./errorCodes";


export interface ApiErrorResponse {
  success: false;
  code: ErrorCode;
  message: string;
}
