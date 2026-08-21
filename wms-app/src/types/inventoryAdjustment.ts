export interface InventoryAdjustmentProduct {
  lineId?: number;
  erpProductId?: number;

  desiredQty?: number;
  citrusQtyBefore?: number;
}


export interface InventoryAdjustmentProgress {
  jobId: number;

  sessionId?: number;

  status:
    | "pending"
    | "processing"
    | "waiting_citrus"
    | "completed"
    | "failed"
    | string;

  phase?: string;

  totalProducts: number;

  processedProducts: number;

  successfulProducts: number;

  failedProducts: number;

  percentage: number;

  currentLineId?: number | null;

  errorMessage?: string | null;

  message?: string;

  currentProduct?:
    InventoryAdjustmentProduct;

  startedAt?: string | null;

  completedAt?: string | null;
}