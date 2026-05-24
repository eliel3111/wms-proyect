import "./OrderLineCard.css"

/* Tipos base */
type Product = {
  id: number;
  sku: string;
  description: string;
  ordered_qty: number;
  received_qty: number;
  product_exists: boolean;
  barcodes: string[];
};

type Props = {
  line: Product;
  validation?: boolean; // 👈 opcional
  editable?: boolean; // 👈 NUEVO
  onEdit?: () => void;
};

export default function OrderLineCard({
  line,
  validation,
  editable,
  onEdit,
}: Props) {

  const differenceQty = line.received_qty - line.ordered_qty;

  const statusClass = validation
    ? "line-default"
    : line.received_qty > 0
      ? "line-ok"
      : line.product_exists === false
        ? "line-error"
        : "line-default";






  return (
    <div className={`order-line ${statusClass}`}>
      <div className="line-sku">{line.sku}</div>
      <div className="line-desc">{line.description}</div>
      <div className="line-qty">
        {Math.trunc(line.received_qty)} / {Math.trunc(line.ordered_qty)}
      </div>




      <div className={`line-diff ${validation ? "red-text" : ""}`}
      >
        {differenceQty}
      </div>

      {/* 👇 BOTÓN SOLO SI editable = true */}
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
