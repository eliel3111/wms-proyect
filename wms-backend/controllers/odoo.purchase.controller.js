import { getActivePurchaseOrders } from "../integrations/odoo/odoo.purchase.service.js";

export async function getPurchaseOrders(req, res) {
  try {
    const orders = await getActivePurchaseOrders();

    return res.json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase orders from Odoo",
    });
  }
}
