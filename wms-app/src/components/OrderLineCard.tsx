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
};

export default function OrderLineCard({ line }: Props) {
  const differenceQty = line.ordered_qty - line.received_qty;

  const statusClass =
    line.product_exists === false
      ? "line-error"
      : line.received_qty > 0
      ? "line-ok"
      : "line-default";

  return (
    <div className={`order-line ${statusClass}`}>
        <div className="line-sku">{line.sku}</div>
        <div className="line-qty">
          {Math.trunc(line.received_qty)} / {Math.trunc(line.ordered_qty)}
        </div>

      <div className="line-desc">{line.description}</div>


        <div className="line-diff">
          {differenceQty}
        </div>

    </div>
  );
}
