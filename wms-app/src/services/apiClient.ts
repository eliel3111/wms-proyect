import axios from "axios";
import type {
  AxiosInstance,
  AxiosError,
  AxiosRequestConfig
} from "axios";




// ---------------------------
// Tipos
// ---------------------------

export type AuthStore = {
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>
  logout: () => Promise<void>;
};

let store: AuthStore | undefined;

// Guardamos el store (AuthProvider nos envía estas funciones)
export function setAuthStore(authStore: AuthStore): void {
  store = authStore;
}

// ---------------------------
// Crear instancia de Axios
// ---------------------------

const apiClient: AxiosInstance = axios.create({
  baseURL: "/api",
  withCredentials: true, // si usas cookies HttpOnly
});

// ---------------------------
// REQUEST INTERCEPTOR
// Añade el header Authorization si hay token
// ---------------------------

apiClient.interceptors.request.use(
  (config) => {
    console.log("REQ INTERCEPTOR → entrando…");

    if (store?.getToken) {
      let token = store.getToken();   // ⬅️ YA NO HAY await
      if (!token) {
        token = localStorage.getItem("accessToken");
      }
      console.log("REQ INTERCEPTOR → token obtenido:", token);

      if (token) {
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${token}`;
      }
    }

    return config;
  },
  (error) => {
    console.log("REQ INTERCEPTOR → ERROR:", error);
    return Promise.reject(error);
  }
);





// ---------------------------
// RESPONSE INTERCEPTOR
// Maneja 401 / 403 y refresh token
// ---------------------------

let isRefreshing = false;
let pendingRequests: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

apiClient.interceptors.response.use(
  (response) => {
    console.log("RES INTERCEPTOR → response OK:", response.config.url);
    return response;
  },

  async (error: AxiosError) => {
    console.log("RES INTERCEPTOR → ERROR:", error.config?.url, error.response?.status);
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };
    console.log(error.config?.url);

    if (error.config?.url === "/auth/refresh") {
      console.log("REFRESH FALLÓ — DESLOGUEANDO…");
      await store?.logout?.();
      return Promise.reject(error);
    }

    // ❌ 403 → sin permisos → logout directo
    if (error.response?.status === 403) {
      await store?.logout?.();
      return Promise.reject(error);
    }

    // 🔄 401 → token expirado → intentar refresh
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      // Si ya estamos refrescando, ponemos esta petición en espera
      if (isRefreshing) {
        console.log
        return new Promise((resolve, reject) => {
          pendingRequests.push({ resolve, reject });
        })
          .then((newToken) => {
            if (!originalRequest.headers) originalRequest.headers = {};
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      // Inicia proceso de refresh
      isRefreshing = true;

      try {
        const newToken = await store!.refreshToken!();
        console.log("EL REFRESF TOKEN DEVUELVE:", newToken);
        console.log("INTERCEPTOR: ¿Tiene retry?", originalRequest._retry);

        // Si refresh falló → Cerrar sesión y rechazar todos los requests
        if (!newToken) {
          pendingRequests.forEach((p) =>
            p.reject(new Error("Refresh token failed"))
          );
          pendingRequests = [];

          await store?.logout?.();
          throw new Error("No new access token");
        }

        // Si refresh fue exitoso → despertar peticiones pendientes
        pendingRequests.forEach((p) => p.resolve(newToken));
        pendingRequests = [];

        if (!originalRequest.headers) originalRequest.headers = {};
        originalRequest.headers.Authorization = `Bearer ${newToken}`;

        return apiClient(originalRequest);
      } catch (err) {
        pendingRequests.forEach((p) => p.reject(err));
        pendingRequests = [];
        console.log("llego error:", err);
        // Si falló → cerrar sesión
        await store?.logout?.();

        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
