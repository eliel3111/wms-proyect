// services/time.service.js

/**
 * Convierte fechas ERP/Citrus a formato comparable
 * sin timezone ni milisegundos.
 *
 * Ejemplo:
 * 2026-05-18T23:04:17.347Z
 * ↓
 * 2026-05-18T23:04:17
 */
export function normalizeERPDate(dateValue) {

    if (!dateValue) return null;

    // Si viene Date object
    if (dateValue instanceof Date) {

        const pad = (n, ms = false) =>
            String(n).padStart(ms ? 3 : 2, "0");

        return `${dateValue.getFullYear()}-${pad(dateValue.getMonth() + 1)}-${pad(dateValue.getDate())}T${pad(dateValue.getHours())}:${pad(dateValue.getMinutes())}:${pad(dateValue.getSeconds())}.${pad(dateValue.getMilliseconds(), true)}`;
    }

    // Si viene string
    return String(dateValue)
        .replace("Z", "")
        .trim();
}
/**
 * Devuelve fecha actual LOCAL del servidor
 * en formato ERP.
 *
 * Ejemplo:
 * 2026-05-18T23:17:00
 */
export function getLocalERPDate(date = new Date()) {

    const pad = (n) => String(n).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Compara dos fechas ERP string.
 *
 * Retorna true si dateA > dateB
 */
export function isERPDateGreater(dateA, dateB) {

    const a = normalizeERPDate(dateA);
    const b = normalizeERPDate(dateB);

    if (!a || !b) return false;

    return a > b;
}