// controllers/authController.js
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import jwt from "jsonwebtoken";


// Tiempo de expiración
const ACCESS_TOKEN_EXPIRES_IN = "9h";
const REFRESH_TOKEN_EXPIRES_IN_DAYS = 7;


export async function logoutUser(req, res) {
  try {
    // 1️⃣ Leer refresh token desde cookie HttpOnly
    const refreshToken = req.cookies.refreshToken; 
    console.log("EL REFESH TOKEN ES:", req);
    if (!refreshToken) {
      return res.status(200).json({ message: "No refresh token found" });
    }

    // 2️⃣ Buscar si existe en la base de datos
    const result = await db.query(
      `SELECT id FROM users WHERE refresh_token = $1`,
      [refreshToken]
    );
    console.log("EL ID ENCONTRADO ES:", result);

    // 3️⃣ Si existe un usuario con ese refresh token → borrarlo
    if (result.rows.length > 0) {
      await db.query(
        `UPDATE users
         SET refresh_token = NULL,
             refresh_token_expires_at = NULL
         WHERE refresh_token = $1`,
        [refreshToken]
      );
    }

    // 4️⃣ Borrar cookie
    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
    });

    // 5️⃣ Respuesta final
    return res.json({ message: "Logout successful" });

  } catch (err) {
    console.error("❌ Error en logout:", err);
    return res.status(500).json({ message: "Server error" });
  }
}



export async function refreshToken(req, res) {
  const refreshToken = req.cookies.refreshToken;
  console.log("ERROR 1");
  console.log(refreshToken);
  if (!refreshToken) {
    return res.status(401).json({ message: "No refresh token" });
  }

  const userResult = await db.query(
    "SELECT id, email, role, refresh_token FROM users WHERE refresh_token = $1",
    [refreshToken]
  );
  console.log("ERROR 2");
  console.log(userResult);
  if (userResult.rows.length === 0) {
    return res.status(401).json({ message: "Invalid refresh token" });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    


    const newAccessToken = jwt.sign(
      { id: decoded.id, role: decoded.role },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    return res.json({ accessToken: newAccessToken });

  } catch (err) {
    return res.status(401).json({ message: "Expired refresh token" });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body;

    // 1️⃣ Validar campos
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const dbCheck = await db.query(`
SELECT current_database(),
inet_server_addr(),
inet_server_port()
`);
console.log("CONECTADO A:", dbCheck.rows);


    // 2️⃣ Normalizar email
    const normalizedEmail = email.trim().toLowerCase();

    // 3️⃣ Buscar usuario por email
    const userResult = await db.query(
      `SELECT 
        id,
        email,
        full_name,
        role,
        password_hash,
        permissions
      FROM users
      WHERE email = $1`,
      [normalizedEmail]
    );

const perm = await db.query(`
SELECT current_database() as db, permissions 
FROM users 
WHERE email=$1
`, [email]);

console.log("PERMISOS VIENEN DE:", perm.rows);


    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    console.log(user);

    // 4️⃣ Comparar contraseña con bcrypt
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // 5️⃣ Generar Access Token
    const accessToken = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );

    // 6️⃣ Generar Refresh Token
    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: `${REFRESH_TOKEN_EXPIRES_IN_DAYS}d` }
    );

    // Calcular expiración del refresh token
    const refreshExpiresAt = new Date();
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + REFRESH_TOKEN_EXPIRES_IN_DAYS);

    // 7️⃣ Guardar refresh token en DB
    await db.query(
      `UPDATE users
       SET refresh_token = $1,
           refresh_token_expires_at = $2,
           last_login = NOW()
       WHERE id = $3`,
      [refreshToken, refreshExpiresAt, user.id]
    );

    // 8️⃣ Remover password del objeto
    delete user.password_hash;

    // 9️⃣ ENVIAR REFRESH TOKEN COMO COOKIE
    res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // solo HTTPS en prod
    sameSite: "strict",
    maxAge: REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
    });

    // 🔟 Respuesta final SIN refresh token en JSON
    return res.json({
    message: "Login successful",
    user,
    accessToken,
    });

    

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}

/**
 * Register new user
 */
export async function registerUser(req, res) {
  try {
    const { email, password, full_name, role, phone, warehouse_id } = req.body;
    console.log(req.body);
    // 1️⃣ Validaciones
    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 2️⃣ Normalizar email
    const normalizedEmail = email.trim().toLowerCase();
    
    // 3️⃣ Verificar si el email ya existe
    const existingUser = await db.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ message: "Email already exists" });
    }

    // 4️⃣ Encriptar password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 5️⃣ Insertar usuario
    const result = await db.query(
      `INSERT INTO users (
        email, password_hash, full_name, role, phone, warehouse_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, email, full_name, role, phone, warehouse_id, created_at`,
      [
        normalizedEmail,
        hashedPassword,
        full_name,
        role,
        phone || null,
        warehouse_id || null,
      ]
    );

    const newUser = result.rows[0];

    // 6️⃣ Responder
    return res.status(201).json({
      message: "User created successfully",
      user: newUser,
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}

