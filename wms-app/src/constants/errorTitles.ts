import type { ErrorCode } from "../types/errorCodes";

export const errorTitles: Record<ErrorCode, string> = {
  QTY_EXCEEDS_AVAILABLE: "Cantidad inválida",
  INVALID_STORAGE_LOCATION: "Ubicación inválida",
  WAREHOUSE_MISMATCH: "Almacén incorrecto",

  NO_ACTIVE_TRANSFER_SESSION: "Sesión no activa",
  SESSION_NOT_FOUND: "Sesión no encontrada",
  SESSION_NOT_OWNED: "Sesión incorrecta",
  SESSION_NOT_ACTIVE: "Sesión no activa",

  USER_LOCATION_NOT_FOUND: "Ubicación no asignada",
  PRODUCT_NOT_FOUND: "Producto no encontrado",
  NO_LINES_IN_USER_LOCATION: "Sin líneas disponibles",
  QTY_EXCEEDS_PENDING_IN_HAND: "Cantidad inválida",
  QTY_NOT_FULFILLED: "Cantidad incompleta",

  SERVER_ERROR: "Error del sistema"
};
