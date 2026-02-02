import xmlrpc from "xmlrpc";

export function getOdooClient(service) {
  return xmlrpc.createSecureClient({
    url: `${process.env.ODOO_URL}/xmlrpc/2/${service}`,
    timeout: 10000,
  });
}
