export function getAdmCloudAuthHeader() {
  const email =
    process.env.ADMCLOUD_EMAIL;

  const password =
    process.env.ADMCLOUD_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Adm Cloud credentials are missing"
    );
  }

  const base64 = Buffer
    .from(`${email}:${password}`)
    .toString("base64");

  return `Basic ${base64}`;
}