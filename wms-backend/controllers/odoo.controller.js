import { authenticateOdoo } from "../integrations/odoo/odoo.auth.js";

export async function authenticate(req, res) {
  try {
    const uid = await authenticateOdoo();

    return res.json({
      success: true,
      uid
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message
    });
  }
}
