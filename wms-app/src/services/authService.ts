import apiClient from "./apiClient.ts";

// ----------------------------
// Tipos
// ----------------------------

export type LoginCredentials = {
  email: string;
  password: string;
};

export type PermissionMap = {
  [module: string]: {
    [action: string]: boolean;
  };
};

export type User = {
  id: number;
  email: string;
  full_name: string;
  role: string;
  permissions: PermissionMap;   // <-- añadir esto
};


export type LoginResponse = {
  user: User;
  accessToken: string;
  refreshToken?: string;
};

export type UserProfileResponse = {
  user: User;
};

// ----------------------------
// Servicios
// ----------------------------

// Login: envía credenciales al backend
export async function loginUser(
  credentials: LoginCredentials
): Promise<LoginResponse> {
  const res = await apiClient.post("/auth/login", credentials);
  console.log("USER FROM API:", res.data.user);
  console.log("PERMISSIONS:", "USER FROM API:", res.data.user.permissions);

  return res.data as LoginResponse;
}

// Obtener perfil del usuario usando el accessToken
export async function getUserProfile(): Promise<UserProfileResponse> {
  console.log("API CALL: GET /auth/me");
  const res = await apiClient.get("/auth/me");
  console.log("API RESPONSE: /auth/me data:", res.data);
  return res.data as UserProfileResponse;
}

// Logout: avisa al backend que invalide el refresh token
export async function logout(): Promise<void> {
  await apiClient.post("/auth/logout");
}

export async function refreshToken(): Promise<{ accessToken: string } | null> {

try {
    const res = await apiClient.post("/auth/refresh");
    console.log("AUTHSERVICE. EL REFRESF TOKEN DEVUELVE:", res);
    return res.data;   // ✔ SOLO devuelve { accessToken }

  } catch (error) {
    console.error("Error en refresh:", error);
    return null; // nunca devuelve null
  }
}

