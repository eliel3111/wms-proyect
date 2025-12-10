import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthProvider";
import type { ReactNode } from "react";


type PrivateRouteProps = {
  children: ReactNode;
};

export default function PrivateRoute({ children }: PrivateRouteProps) {
  const { isAuthenticated, loading } = useAuth();
  
    // 👇 Muy importante: NO renderizar nada mientras verificamos sesión
  if (loading) {
    return <div>Cargando sesión...</div>;
  }

  // Si NO está logueado, redirigimos al login
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Si está logueado, mostramos la página protegida
  return children;
}
