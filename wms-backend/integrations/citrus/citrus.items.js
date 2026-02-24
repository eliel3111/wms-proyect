import { callERP } from "./erpClient.js";


//ESTO ES PARA PODER BUSCAR POR PAGUINA Y CANTIDAD LOS PRODUCTOS
export async function fetchItemsPage(page = 0, pageSize = 50) {
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
    console.log("SE RECIVIO", items)
    console.log(`📦 Página ${page} → ${items.length} items`);

    return items;

  } catch (error) {
    console.error("🔥 fetchItemsPage error:", error.message);
    return [];
  }
}
