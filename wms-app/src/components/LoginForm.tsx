import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthProvider.tsx";
import { useNavigate } from "react-router-dom";
import "../styles/LoginForm.css"; 



export default function LoginForm() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  
  const { user, isAuthenticated } = useAuth();

  useEffect(() => {
  console.log("Usuario actualizado:", user);
  console.log("Autenticado:", isAuthenticated);


}, [user, isAuthenticated]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
    setError("");
    try {
      await login({ email, password });
      console.log("Eliel");

      // ⬇️ Redirigir al dashboard
      navigate("/dashboard", { replace: true });

    } catch (err) {
      console.error(err);
      setError("Credenciales inválidas");
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">Iniciar sesión</h1>
        <p className="login-subtitle">Accede a tu cuenta del sistema WMS</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">Correo electrónico</label>
            <input
              id="email"
              type="email"
              placeholder="tu@correo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="input"
            />
          </div>

          {error && <p className="error-message">{error}</p>}

          <button type="submit" className="btn-primary">
            Entrar
          </button>

          
        </form>
      </div>
    </div>
  );
}
