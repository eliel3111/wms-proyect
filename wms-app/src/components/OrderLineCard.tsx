import "./OrderLineCard.css";

/* Tipos base */
type Product = {
  id: number;
  sku: string;
  description: string;
  ordered_qty: number;
  received_qty: number;
  min_received_qty?: number;
  product_exists?: boolean;
  barcodes?: string[];
  erp_name?: string | null;
  erp_sku?: string | null;
  erp_id?: number;
};

type Props = {
  line: Product;
  validation?: boolean;
  editable?: boolean;
  onEdit?: () => void;
};

export default function OrderLineCard({
  line,
  validation = false,
  editable = false,
  onEdit,
}: Props) {
  /*
   * Cantidad acumulada antes de esta recepción.
   * Si no viene del backend, se considera cero.
   */
  const previousReceived = Number(
    line.min_received_qty ?? 0
  );

  /*
   * Cantidad recibida solamente durante
   * la recepción actual.
   */
  const displayReceived = Math.max(
    Number(line.received_qty ?? 0) -
      previousReceived,
    0
  );

  /*
   * Cantidad que faltaba recibir cuando
   * comenzó esta recepción.
   */
  const displayOrdered = Math.max(
    Number(line.ordered_qty ?? 0) -
      previousReceived,
    0
  );

  /*
   * Diferencia exclusiva de esta recepción.
   */
  const differenceQty =
    displayReceived - displayOrdered;

  /*
   * El estado visual debe depender de lo contado
   * en ESTA recepción, no del acumulado histórico.
   */
  const statusClass = validation
    ? "line-default"
    : displayReceived > 0
      ? "line-ok"
      : line.product_exists === false
        ? "line-error"
        : "line-default";

  return (
    <div className={`order-line ${statusClass}`}>
      <div className="line-sku">
        {line.erp_name}
      </div>

      <div className="line-desc">
        {line.description}

        <br />

        <strong>PN:</strong>{" "}
        {line.erp_sku ?? "N/A"}

        {" | "}

        <strong>ID:</strong>{" "}
        {line.erp_id ?? "N/A"}
      </div>

      <div className="line-qty">
        {Math.trunc(displayReceived)}
        {" / "}
        {Math.trunc(displayOrdered)}
      </div>

      <div
        className={`line-diff ${
          validation ? "red-text" : ""
        }`}
      >
        {Math.trunc(differenceQty)}
      </div>

      {editable && (
        <button
          className="line-edit-btn"
          onClick={onEdit}
        >
          Editar
        </button>
      )}
    </div>
  );
}