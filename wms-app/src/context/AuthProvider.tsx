import { createContext, useContext, useState, useEffect, useRef } from "react";

import type { ReactNode } from "react";

import * as authService from "../services/authService.js";
import { setAuthStore } from "../services/apiClient.js";
import { useNavigate } from "react-router-dom";

// ----------------------------
// TIPOS
// ----------------------------

export type User = {
  id: number;
  email: string;
  full_name: string;
  permissions: PermissionMap;
};

export type PermissionMap = {
  [module: string]: {
    [action: string]: boolean;
  };
};

export type AuthContextType = {
  user: User | null;
  isAuthenticated: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>;
  can: (permission: string) => boolean;
};

export type LoginCredentials = {
  email: string;
  password: string;
};

// ----------------------------
// CREAR CONTEXTO
// ----------------------------

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ----------------------------
// PROPS DEL PROVIDER
// ----------------------------

type AuthProviderProps = {
  children: ReactNode;
};

// ----------------------------
// AUTH PROVIDER
// ----------------------------

export function AuthProvider({ children }: AuthProviderProps) {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Obtener token (usado por interceptores)
  const getToken = () => accessToken;


  


  // ----------------------------
  // LOGIN
  // ----------------------------

  async function login(credentials: LoginCredentials): Promise<void> {
    const data = await authService.loginUser(credentials);
    // data = { user, accessToken, refreshToken }
    console.log(data.user)
    setUser(data.user);
    setAccessToken(data.accessToken);
    localStorage.setItem("accessToken", data.accessToken);



    if (data.refreshToken) {
      localStorage.setItem("refreshToken", data.refreshToken);
    }
  }


  // Definir funcion para los permisos:

  const can = (permission: string): boolean => {
    console.log("ALERTA", user);
    if (!user?.permissions) return false;

    const parts = permission.split(".");
    if (parts.length !== 2) return false;

    const [module, action] = parts;

    return user.permissions[module]?.[action] === true;
  };

  // ----------------------------
  // LOGOUT
  // ----------------------------

  async function logout(): Promise<void> {
    try {
      await authService.logout(); // opcional
    } catch (e) {
      console.error("Error en logout:", e);
    }

    setUser(null);
    setAccessToken(null);

    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");

    navigate("/login", { replace: true });
  }

  // ----------------------------
  // REFRESH TOKEN AUTOMÁTICO
  // ----------------------------

  async function refreshToken(): Promise<string | null> {
  try {
    const data = await authService.refreshToken(); 
    // data = { accessToken: string }
    console.log("AUTHPROVIDER. EL REFRESF TOKEN DEVUELVE:", data);
    if (!data || !data.accessToken) {
      throw new Error("No se pudo refrescar el token");
    }

    localStorage.setItem("accessToken", data.accessToken);
    setAccessToken(data.accessToken);

    return data.accessToken;

  } catch (err) {
    console.error("Error en refresh access:", err);
    return null;
  }
}



  // ----------------------------
  // CHECK SESSION AL RECARGAR
  // ----------------------------

  async function checkSession() {
  console.log("CHECK 1: checkSession() inició");

  const storedAccess = localStorage.getItem("accessToken");
  console.log("CHECK 2: storedAccess =", storedAccess);

  if (!storedAccess) {
    console.log("CHECK 3: No hay token en localStorage → loading = false");
    setLoading(false);
    return;
  }

  try {
    console.log("CHECK 4: Seteando accessToken en estado");
    setAccessToken(storedAccess);

    console.log("CHECK 5: Llamando getUserProfile()…");
    const data = await authService.getUserProfile();  
    console.log("CHECK 6: getUserProfile() respondió:", data);
    setUser(data.user);
    console.log("CHECK 7: user seteado:", data.user);

  } catch (e) {
  console.log("CHECK 8: ERROR en getUserProfile:", e);
  console.log("CHECK 9: Ejecutando logout()");
  await logout();
  return; // 👈 ESTO ES CLAVE PARA PARAR EL LOOP
} finally {
  console.log("CHECK 10: Terminando → setLoading(false)");
  setLoading(false);
}

}


  // ----------------------------
  // SETUP DEL AUTH STORE (apiClient)
  // ----------------------------

const hasRun = useRef(false);

useEffect(() => {
  if (hasRun.current) return;
  hasRun.current = true;

  setAuthStore({ getToken, refreshToken, logout });
  checkSession();
}, []);

useEffect(() => {
  console.log("AUTH USER:", user);
  console.log("AUTH PERMISSIONS:", user?.permissions);
}, [user]);



  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    loading,
    getToken,      // <-- AÑADIR ESTO AQUÍ
    refreshToken,  // <-- YA EXISTE
    can,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
      {loading && <div>Cargando sesión...</div>}
    </AuthContext.Provider>
  );
}


// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth debe usarse dentro de un AuthProvider");
  }
  return ctx;
}



// Marca el hook como "usado" para TS
export const __useAuthMarker = useAuth;