import { callERP } from "./erpClient.js";


//ESTO ES PARA PODER BUSCAR POR PAGUINA Y CANTIDAD LOS PRODUCTOS
export async function fetchItemsPage(page, pageSize, fechaInicioFormatted, fechaFinFormatted) {
  try {





const xml = `
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tem="http://tempuri.org/"
  xmlns:bas="BaseModel.Where">
  <soap:Body>
    <tem:BuscarItems>
      <tem:itemWhere>
        <bas:CantidadPorPagina>${pageSize}</bas:CantidadPorPagina>
        <bas:Pagina>${page}</bas:Pagina>

        <tem:FechaInicioActualizacion>${fechaInicioFormatted}</tem:FechaInicioActualizacion>
        <tem:FechaFinActualizacion>${fechaFinFormatted}</tem:FechaFinActualizacion>

      </tem:itemWhere>
    </tem:BuscarItems>
  </soap:Body>
</soap:Envelope>
`;

    const data = await callERP(
      "Inventario/ItemService.asmx",
      "http://tempuri.org/BuscarItems",
      xml
    );

    // 🔴 error ERP
    if (!data || data.Success === 0) {
      console.log("🔴 ERP respondió error:", data?.Mensaje);
      return [];
    }
    
    const items = data?.Data?.Items || [];
    //console.log("SE RECIVIO", items)
    console.log(`📦 Página ${page} → ${items.length} items`);

    return items;

  } catch (error) {
    console.error("🔥 fetchItemsPage error:", error.message);
    return [];
  }
}

export async function fetchPurchaseOrdersPage(page, pageSize, fechaInicioFormatted, fechaFinFormatted) {
  try {

const xml = `
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tem="http://tempuri.org/">

  <soap:Body>

    <tem:BuscarOrdenesCompras>

      <tem:ordenCompraWhere>

        <tem:Pagina>${page}</tem:Pagina>
        <tem:CantidadPorPagina>${pageSize}</tem:CantidadPorPagina>

        <tem:EsFecha>true</tem:EsFecha>
        <tem:FechaInicio>${fechaInicioFormatted}</tem:FechaInicio>
        <tem:FechaFin>${fechaFinFormatted}</tem:FechaFin>

        <tem:EsAscendente>true</tem:EsAscendente>
        <tem:EsOrdenable>false</tem:EsOrdenable>

      </tem:ordenCompraWhere>

    </tem:BuscarOrdenesCompras>

  </soap:Body>

</soap:Envelope>
`;

    const data = await callERP(
  "CxP/OrdenCompraService.asmx",
  "http://tempuri.org/BuscarOrdenesCompras",
  xml
);

    // 🔴 error ERP
    if (!data || data.Success === 0) {
      console.log("🔴 ERP respondió error:", data?.Mensaje);
      return [];
    }

   const resultString =
  data?.BuscarOrdenesComprasResponse?.BuscarOrdenesComprasResult;

if (!resultString) {
  console.log("⚠️ Unexpected ERP structure:", data);
  return [];
}

const parsed = JSON.parse(resultString);

if (!parsed.Success) {
  console.log("🔴 ERP error:", parsed.Mensaje);
  return [];
}

const orders = parsed?.Data?.OrdenCompras || [];

console.log(`📦 Ordenes recibidas: ${orders.length}`);

return orders;

  } catch (error) {
    console.error("🔥 fetchPurchaseOrdersPage error:", error.message);
    return [];
  }
}