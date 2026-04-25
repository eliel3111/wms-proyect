import sgMail from "@sendgrid/mail";
import axios from "axios";
import { AxiosHeaders } from "axios";
import { getAlegraAuthHeader } from "./alegraAuth.js";


const alegraClient = axios.create({
  baseURL: "https://api.alegra.com/api/v1",
  timeout: 10000,
});

// 🔹 REQUEST INTERCEPTOR
alegraClient.interceptors.request.use((config) => {
  if (!config.headers) {
    config.headers = new AxiosHeaders();
  }

  config.headers.set("Authorization", getAlegraAuthHeader());
  config.headers.set("Content-Type", "application/json");

  return config;
});

alegraClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // 🔴 ERROR SIN RESPONSE (ej: env missing, network)
    if (!error.response) {
      console.error("❌ Error sin respuesta del servidor:", error.message);

      await sendErrorEmail({
        subject: "Alegra Internal Error",
        message: error.message,
      });

      throw {
        status: 500,
        message: error.message,
        data: null,
      };
    }

    // 🔥 CENTRALIZAMOS
    const status = error.response.status;
    const data = error.response.data;

    console.log("STATUS:", status);
    console.log("DATA:", data);

    // =========================
    // 🔁 401 → Retry
    // =========================
    if (status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      console.warn("⚠️ 401 recibido, reintentando...");

      try {
        return await alegraClient(originalRequest);
      } catch (retryError) {
        await sendErrorEmail({
          subject: "Alegra Auth Error (401)",
          message: retryError.message,
        });

        throw retryError;
      }
    }

    // =========================
    // 🚫 403 → Permisos
    // =========================
    if (status === 403) {
      console.error("🚫 403 Forbidden:", data);

      await sendErrorEmail({
        subject: "Alegra Forbidden (403)",
        message: `
No tienes permisos para este endpoint.

Mensaje: ${data?.message}
URL: ${originalRequest?.url}
Método: ${originalRequest?.method}
        `,
      });

      throw { status, message: data?.message, data };
    }

    // =========================
    // ❌ 400 → Bad Request
    // =========================
    if (status === 400) {
      console.error("❌ 400 Bad Request:", data);

      throw {
        status,
        message: "Request mal formado",
        data,
      };
    }

    // =========================
    // 💳 402 → Suspensión
    // =========================
    if (status === 402) {
      console.error("💳 402 Payment Required");

      await sendErrorEmail({
        subject: "Alegra Suspended Account (402)",
        message: data?.message,
      });

      throw { status, message: data?.message, data };
    }

    // =========================
    // 🔍 404 → Not Found
    // =========================
    if (status === 404) {
      console.warn("🔍 404 Not Found");

      throw {
        status,
        message: "Recurso no encontrado",
        data,
      };
    }

    // =========================
    // 🚫 405 → Method
    // =========================
    if (status === 405) {
      console.error("🚫 405 Method Not Allowed");

      throw {
        status,
        message: "Método no permitido",
        data,
      };
    }

    // =========================
    // 🔥 500 → Server
    // =========================
    if (status === 500) {
      console.error("🔥 500 Server Error");

      await sendErrorEmail({
        subject: "Alegra Server Error (500)",
        message: JSON.stringify(data),
      });

      throw { status, message: "Error interno Alegra", data };
    }

    // =========================
    // 🛑 503 → Mantenimiento
    // =========================
    if (status === 503) {
      console.warn("🛑 503 Service Unavailable");

      await sendErrorEmail({
        subject: "Alegra Maintenance (503)",
        message: "Servicio no disponible",
      });

      throw { status, message: "Servicio no disponible", data };
    }

    // =========================
    // ⚠️ Fallback
    // =========================
    console.error("❌ Error no manejado:", error.message);

    throw {
      status,
      message: error.message,
      data,
    };
  }
);

export default alegraClient;


// utils/sendEmail.js



sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export async function sendErrorEmail({ subject, message }) {
  await sgMail.send({
    to: "eliel3111@gmail.com",
    from: process.env.SENDGRID_FROM_EMAIL,
    subject,
    html: `<pre>${message}</pre>`,
  });
}