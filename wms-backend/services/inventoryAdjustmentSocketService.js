import db from "../db.js";
import { getIO } from "../socket.js";


export async function emitInventoryAdjustmentProgress(
  jobId,
  extra = {}
) {

  try {

    const result =
      await db.query(
        `
        SELECT
          id,
          inventory_session_id,
          status,
          total_products,
          processed_products,
          successful_products,
          failed_products,
          current_line_id,
          error_message,
          started_at,
          completed_at

        FROM inventory_adjustment_jobs

        WHERE id = $1

        LIMIT 1
        `,
        [
          jobId
        ]
      );


    const job =
      result.rows[0];


    if (!job) {

      console.log(
        `⚠️ No existe job ${jobId} para emitir progreso`
      );

      return;

    }


    const totalProducts =
      Number(
        job.total_products
      ) || 0;


    const processedProducts =
      Number(
        job.processed_products
      ) || 0;


    const successfulProducts =
      Number(
        job.successful_products
      ) || 0;


    const failedProducts =
      Number(
        job.failed_products
      ) || 0;


    const percentage =
      totalProducts > 0
        ? Math.round(
            (
              processedProducts /
              totalProducts
            ) * 100
          )
        : 0;


    const payload = {

      jobId:
        Number(job.id),

      sessionId:
        Number(
          job.inventory_session_id
        ),

      status:
        job.status,

      totalProducts,

      processedProducts,

      successfulProducts,

      failedProducts,

      percentage,

      currentLineId:
        job.current_line_id
          ? Number(job.current_line_id)
          : null,

      errorMessage:
        job.error_message,

      startedAt:
        job.started_at,

      completedAt:
        job.completed_at,

      ...extra

    };


    const io =
      getIO();


    const room =
      `inventory_adjustment_job:${jobId}`;


    io
      .to(room)
      .emit(
        "inventory_adjustment:progress",
        payload
      );


    console.log(
      "📡 INVENTORY PROGRESS:",
      `${processedProducts}/${totalProducts}`,
      `${percentage}%`
    );


    return payload;


  } catch (error) {

    console.error(
      "❌ Error emitiendo inventory adjustment progress:",
      error
    );

  }

}
