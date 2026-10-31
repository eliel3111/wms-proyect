import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthProvider.tsx";
import { useNavigate } from "react-router-dom";
import "../styles/LoginForm.css";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function LoginForm() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // ✅ NUEVO
  const [loading, setLoading] = useState(false);

  const { user, isAuthenticated } = useAuth();

  useEffect(() => {
    console.log("Usuario actualizado:", user);
    console.log("Autenticado:", isAuthenticated);
  }, [user, isAuthenticated]);

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();

    // Evita doble click
    if (loading) return;

    setError("");
    setLoading(true);

    try {
      await login({
        email,
        password,
      });

      navigate("/menu", {
        replace: true,
      });

    } catch (err) {
      console.error(err);

      setError(
        "Credenciales inválidas"
      );

    } finally {
      // ✅ SIEMPRE SE APAGA
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">

        <h1 className="login-title">
          Iniciar sesión
        </h1>

        <p className="login-subtitle">
          Accede a tu cuenta del sistema WMS
        </p>

        <form
          onSubmit={handleSubmit}
          className="login-form"
        >

          <div className="form-group">

            <label htmlFor="email">
              Correo electrónico
            </label>

            <input
              id="email"
              type="email"
              placeholder="tu@correo.com"
              value={email}
              onChange={(e) =>
                setEmail(e.target.value)
              }
              required
              className="input"

              // ✅ OPCIONAL
              disabled={loading}
            />

          </div>

          <div className="form-group">

            <label htmlFor="password">
              Contraseña
            </label>

            <div className="password-wrapper">

              <input
                id="password"
                type={
                  showPassword
                    ? "text"
                    : "password"
                }
                placeholder="••••••••"
                value={password}
                onChange={(e) =>
                  setPassword(e.target.value)
                }
                required
                className="input"

                // ✅ OPCIONAL
                disabled={loading}
              />

              <button
                type="button"
                className="toggle-password"
                onClick={() =>
                  setShowPassword(
                    !showPassword
                  )
                }
                disabled={loading}
              >
                {showPassword
                  ? <EyeOff size={20} />
                  : <Eye size={20} />
                }
              </button>

            </div>
          </div>

          {error && (
            <p className="error-message">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary"

            // ✅ IMPORTANTE
            disabled={loading}
          >

            {loading ? (
              <span className="login-loading">
                <Loader2
                  size={18}
                  className="login-spinner"
                />
                Entrando...
              </span>
            ) : (
              "Entrar"
            )}

          </button>

        </form>
      </div>
    </div>
  );
}