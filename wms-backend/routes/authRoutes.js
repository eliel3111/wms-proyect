import express from "express";
import { login, registerUser, refreshToken, logoutUser } from "../controllers/authController.js";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/login", login);

router.post("/refresh", refreshToken);

router.post("/register", registerUser);

router.post("/logout", logoutUser);

// Ruta privada: el usuario debe estar autenticado
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // viene del middleware

    const result = await db.query(
      `
      SELECT
        id,
        email,
        full_name,
        role,
        phone,
        warehouse_id,
        permissions,
        created_at,
        last_login
      FROM users
      WHERE id = $1
      `,
      [userId]
    );


    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = result.rows[0];

    return res.json({
      message: "User profile",
      user,
    });

  } catch (error) {
    console.error("PROFILE ERROR:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


/*Aquí asumo que tu backend tiene rutas como:

POST /api/auth/login

GET /api/auth/me

POST /api/auth/logout*/

export default router;
