import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {

  console.log("🔍 authMiddleware ejecutándose...");
  console.log("Authorization header:", req.headers.authorization);

  // 1. Leer el header Authorization
  const authHeader = req.headers.authorization;

  console.log(authHeader);

  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  // Esperamos el formato: "Bearer <token>"
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Invalid Authorization format" });
  }

  try {
    // 2. Verificar el token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 3. Guardar info del usuario en req.user
    // decoded suele tener: { id, role, iat, exp }
    req.user = decoded;

    // 4. Pasar al siguiente middleware / controlador
    next();
  } catch (err) {
    console.error("JWT ERROR:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
