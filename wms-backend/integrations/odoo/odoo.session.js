import { authenticateOdoo } from "./odoo.auth.js";

let cachedUid = null;

export async function getOdooUid() {
  if (cachedUid) return cachedUid;

  cachedUid = await authenticateOdoo();
  return cachedUid;
}


/*import { getOdooUid } from "../integrations/odoo/odoo.session.js";

export async function getProducts(req, res) {
  const uid = await getOdooUid();
  // usar uid
}
*/