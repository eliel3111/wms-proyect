import { db } from "../db.js";


export async function getPendingPutaway(req, res) {
  console.log("🔥 GET /putaway/pending funcionando");

  return res.json({
    success: true,
    data: []
  });
}


export default router;


